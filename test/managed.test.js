const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const { createHash } = require("node:crypto")
const { signature } = require("../services/managedProtocol")
const { createManagedJournal } = require("../services/managedJournal")
const { createManagedWorker } = require("../services/managedWorker")
const { createApp } = require("../app")

const assignment = { id: "assignment-1", tenantId: "tenant-1", fence: 1 }
const secret = "offline-managed-test-secret-with-32-bytes"
async function directory(t) {
 const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "managed-worker-test-"))
 return dataDir
}
async function eventually(check) {
 for (let tries = 0; tries < 200; tries++) {
  if (await check()) return
  await new Promise((resolve) => setTimeout(resolve, 5))
 }
 assert.fail("Expected managed condition did not become true")
}
async function fixture(t, options = {}) {
 const dataDir = options.dataDir || await directory(t)
 const calls = [], receipts = new Set()
 let sends = 0, starts = 0, resets = 0, connected = true
 const connection = {
  getConnectionStatus: () => ({ state: connected ? "connected" : "stopped", connected }),
  getQrStatus: () => ({ state: "qr_required", connected: false, qr: "offline-qr", expiresAt: new Date(Date.now() + 20000).toISOString() }),
  subscribeMessageUpdates(listener) { receipts.add(listener); return () => receipts.delete(listener) },
  async startWhatsApp() { starts++; connected = true }, async stopWhatsApp() { connected = false },
  async resetWhatsApp() { resets++; connected = false; if (options.failReset) throw new Error("offline") },
  async requestQr() {},
  getSocket() { return connected ? socket : null }
 }
 const socket = { user: { id: "offline" }, async sendMessage(_jid, _content, sendOptions) {
  sends++
  if (options.send) return options.send(sendOptions)
  return { key: { id: sendOptions.messageId } }
 } }
 const gateway = async (url, body, method) => {
  calls.push({ url, body, method })
  if (options.gateway) { const result = await options.gateway(url, body, method); if (result !== undefined) return result }
  if (url.endsWith("/assignment")) return { assignment: options.unassigned ? null : assignment }
  if (url.endsWith("/send-start")) return { authorized: true, leaseExpiresAt: Date.now() + 60000, authorizationExpiresAt: Date.now() + 10000 }
  return { success: true }
 }
 const worker = createManagedWorker({ env: { WORKER_ID: "worker-1", WORKER_SECRET: secret, DATA_DIR: dataDir, GATEWAY_URL: "https://gateway.example" },
  connection, gateway, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}), ...(options.staging ? { staging: options.staging } : {}), minIntervalMs: 0, sendTimeoutMs: options.sendTimeoutMs || 1000,
  generateMessageId: () => "OFFLINE-MANAGED-ID" })
 await worker.start()
 t.after(async () => { await worker.shutdown(); await fs.rm(dataDir, { recursive: true, force: true }) })
 const dispatch = (overrides = {}) => worker.dispatch({ jobId: "job-1", tenantId: "tenant-1", assignmentId: "assignment-1", assignmentFence: 1,
  attemptId: "attempt-1", attemptFence: 1, leaseExpiresAt: Date.now() + 60000,
  payload: { phone: "12025550123", message: "offline fixture" }, ...overrides })
 return { worker, calls, receipts, dispatch, dataDir, connection,
  get sends() { return sends }, get starts() { return starts }, get resets() { return resets } }
}

test("managed journal survives restart and detects corruption", async (t) => {
 const dataDir = await directory(t)
 let journal = await createManagedJournal({ dataDir })
 await journal.update((data) => { data.assignment = assignment })
 await journal.close()
 journal = await createManagedJournal({ dataDir })
 assert.deepEqual(journal.read().assignment, assignment)
 await journal.close()
 const filename = path.join(dataDir, "managed-journal.json")
 const envelope = JSON.parse(await fs.readFile(filename, "utf8"))
 envelope.data.assignment.tenantId = "another-tenant"
 await fs.writeFile(filename, JSON.stringify(envelope))
 await assert.rejects(createManagedJournal({ dataDir }), /integrity/)
 await fs.rm(dataDir, { recursive: true, force: true })
})

test("managed journal bounds capacity, serializes writes and excludes a second process", async (t) => {
 const dataDir = await directory(t)
 const journal = await createManagedJournal({ dataDir, maxJobs: 2 })
 t.after(async () => { await journal.close(); await fs.rm(dataDir, { recursive: true, force: true }) })
 await assert.rejects(createManagedJournal({ dataDir }), /already in use/)
 await Promise.all([journal.update((data) => { data.jobs.one = { status: "sent" } }), journal.update((data) => { data.jobs.two = { status: "sent" } })])
 await assert.rejects(journal.update((data) => { data.jobs.three = {} }), /capacity/)
 assert.equal(Object.keys(journal.read().jobs).length, 2)
})

test("managed journal recovers a stale lock when a container reuses its PID", async (t) => {
 const dataDir = await directory(t)
 await fs.writeFile(path.join(dataDir, "managed-worker.lock"), JSON.stringify({ pid: process.pid, ownerToken: "previous-process-incarnation", startIdentity: "previous-container" }))
 const journal = await createManagedJournal({ dataDir })
 t.after(async () => { await journal.close(); await fs.rm(dataDir, { recursive: true, force: true }) })
 await journal.update((data) => { data.state = "unassigned" })
 assert.equal(journal.read().state, "unassigned")
})

test("bootstrap reconciles assignment before any credential load", async (t) => {
 const f = await fixture(t)
 assert.equal(f.worker.readiness().ready, true)
 assert.equal(f.starts, 0)
 assert.equal(f.calls[0].url, "/internal/v1/workers/worker-1/assignment")
 assert.equal(f.worker.capabilities().clean, false)
})

test("unowned disk credentials quarantine bootstrap without loading auth", async (t) => {
 const dataDir = await directory(t)
 await fs.mkdir(path.join(dataDir, "auth"))
 await fs.writeFile(path.join(dataDir, "auth", "creds.json"), JSON.stringify({ registered: true }))
 const f = await fixture(t, { dataDir, unassigned: true })
 assert.equal(f.worker.readiness().ready, false)
 assert.equal(f.starts, 0)
 assert.equal(f.worker.capabilities().clean, false)
 await assert.rejects(f.dispatch(), { code: "WORKER_QUARANTINED" })
})

test("dispatch is durably admitted and duplicate dispatch sends only once", async (t) => {
 const f = await fixture(t)
 await f.dispatch()
 await f.dispatch()
 await eventually(() => f.worker.debugSnapshot().jobs["job-1"].status === "sent")
 await eventually(() => f.calls.some((call) => call.url.endsWith("/events")))
 assert.equal(f.sends, 1)
 const sendStart = f.calls.findIndex((call) => call.url.endsWith("/send-start"))
 const report = f.calls.findIndex((call) => call.url.endsWith("/events"))
 assert.ok(sendStart >= 0 && report > sendStart)
 const envelope = JSON.parse(await fs.readFile(path.join(f.dataDir, "managed-journal.json"), "utf8"))
 assert.equal(envelope.data.jobs["job-1"].status, "sent")
 assert.equal(envelope.data.jobs["job-1"].payload, undefined)
})

test("dispatch rejects changed payload, foreign tenant and stale fences", async (t) => {
 const f = await fixture(t)
 await assert.rejects(f.dispatch({ tenantId: "tenant-2" }), { code: "STALE_ASSIGNMENT" })
 await assert.rejects(f.dispatch({ assignmentFence: 2 }), { code: "STALE_ASSIGNMENT" })
 await f.dispatch()
 await assert.rejects(f.dispatch({ payload: { phone: "12025550123", message: "changed" } }), { code: "JOB_CONFLICT" })
})

test("gateway authorization failure prevents WhatsApp sending", async (t) => {
 const f = await fixture(t, { gateway: async (url) => url.endsWith("/send-start") ? { authorized: false } : undefined })
 await f.dispatch()
 await eventually(() => f.worker.debugSnapshot().jobs["job-1"].status === "failed")
 assert.equal(f.sends, 0)
 assert.equal(f.worker.debugSnapshot().jobs["job-1"].retryable, true)
})

test("pre-send retry requires a greater attempt fence and cannot repeat an old attempt", async (t) => {
 let first = true
 const f = await fixture(t, { gateway: async (url) => {
  if (url.endsWith("/send-start") && first) { first = false; return { authorized: false } }
 } })
 await f.dispatch()
 await eventually(() => f.worker.debugSnapshot().jobs["job-1"].status === "failed")
 await assert.rejects(f.dispatch({ attemptId: "attempt-2", attemptFence: 1 }), { code: "JOB_CONFLICT" })
 await assert.rejects(f.dispatch({ attemptId: "attempt-2", attemptFence: 2, payload: { phone: "12025550123", message: "changed recipient content" } }), { code: "JOB_CONFLICT" })
 await f.dispatch({ attemptId: "attempt-2", attemptFence: 2 })
 await eventually(() => f.worker.debugSnapshot().jobs["job-1"].status === "sent")
 assert.equal(f.sends, 1)
 await assert.rejects(f.dispatch(), { code: "JOB_CONFLICT" })
})

test("ambiguous send is unknown, quarantines the socket and never resends", async (t) => {
 const f = await fixture(t, { send: async () => { throw new Error("socket closed after possible transmission") } })
 await f.dispatch()
 await eventually(() => f.worker.debugSnapshot().jobs["job-1"].status === "unknown")
 assert.equal(f.sends, 1)
 await eventually(() => !f.worker.readiness().ready)
 await assert.rejects(f.dispatch({ attemptId: "attempt-2", attemptFence: 2 }), { code: "WORKER_QUARANTINED" })
})

test("restart with durable send intent reports unknown without sending", async (t) => {
 const dataDir = await directory(t)
 const journal = await createManagedJournal({ dataDir })
 await journal.update((data) => {
  data.assignment = assignment; data.state = "assigned"
  data.jobs["job-1"] = { jobId: "job-1", assignmentId: assignment.id, assignmentFence: 1, attemptId: "attempt-1", attemptFence: 1, messageId: "OFFLINE-MANAGED-ID", status: "sending" }
 })
 await journal.close()
 const f = await fixture(t, { dataDir })
 assert.equal(f.worker.debugSnapshot().jobs["job-1"].status, "unknown")
 assert.equal(f.sends, 0)
 await eventually(() => f.calls.some((call) => call.body?.status === "unknown"))
})

test("result reporting retries the outbox without repeating a send", async (t) => {
 let failing = true
 const f = await fixture(t, { gateway: async (url) => {
  if (url.endsWith("/events") && failing) throw new Error("gateway offline")
 } })
 await f.dispatch()
 await eventually(() => f.worker.debugSnapshot().jobs["job-1"].status === "sent")
 assert.equal(f.worker.debugSnapshot().outbox.length, 1)
 const event = f.worker.debugSnapshot().outbox[0].body.eventId
 failing = false
 await new Promise(setImmediate)
 await f.worker.flush()
 assert.equal(f.worker.debugSnapshot().outbox.length, 0)
 assert.equal(f.sends, 1)
 assert.equal(f.calls.filter((call) => call.body?.eventId === event).length, 2)
})

test("late and out-of-order receipts advance monotonically", async (t) => {
 const f = await fixture(t)
 await f.dispatch()
 await eventually(() => f.worker.debugSnapshot().jobs["job-1"].status === "sent")
 for (const callback of f.receipts) callback({ messageId: "OFFLINE-MANAGED-ID", status: "read" })
 await eventually(() => f.worker.debugSnapshot().jobs["job-1"].status === "read")
 for (const callback of f.receipts) callback({ messageId: "OFFLINE-MANAGED-ID", status: "delivered" })
 await new Promise(setImmediate)
 assert.equal(f.worker.debugSnapshot().jobs["job-1"].status, "read")
})

test("reset confirms revocation, removes customer journal residue and is idempotent", async (t) => {
 const f = await fixture(t)
 await f.dispatch()
 await eventually(() => f.worker.debugSnapshot().jobs["job-1"].status === "sent")
 const body = { operationId: "reset-1", assignmentId: assignment.id, fence: 1 }
 assert.equal((await f.worker.reset(body)).clean, true)
 assert.equal(f.worker.capabilities().clean, true)
 assert.equal(Object.keys(f.worker.debugSnapshot().jobs).length, 0)
 assert.equal((await f.worker.reset(body)).clean, true)
 assert.equal(f.resets, 1)
})

test("reset failures quarantine a worker instead of making it available", async (t) => {
 const f = await fixture(t, { failReset: true })
 await assert.rejects(f.worker.reset({ operationId: "reset-1", assignmentId: assignment.id, fence: 1 }), { code: "RESET_FAILED" })
 assert.equal(f.worker.capabilities().clean, false)
 assert.equal(f.worker.readiness().ready, false)
})

test("managed HTTP requires HMAC over the exact raw body and disables local ingress", async (t) => {
 const f = await fixture(t)
 const app = createApp({ managedWorker: f.worker, apiKey: "unused-offline-local-key" })
 const server = app.listen(0, "127.0.0.1")
 await new Promise((resolve) => server.once("listening", resolve))
 t.after(() => new Promise((resolve) => server.close(resolve)))
 const base = `http://127.0.0.1:${server.address().port}`
 assert.equal((await fetch(`${base}/live`)).status, 200)
 assert.equal((await fetch(`${base}/qr`)).status, 404)
 assert.equal((await fetch(`${base}/api/send`, { method: "POST" })).status, 404)
 const pathname = "/internal/v1/capabilities", timestamp = String(Date.now())
 assert.equal((await fetch(`${base}${pathname}`)).status, 401)
 const expired = String(Date.now() - 600000)
 assert.equal((await fetch(`${base}${pathname}`, { headers: { "x-worker-id": "worker-1", "x-timestamp": expired,
  "x-signature": signature(secret, "GET", pathname, expired) } })).status, 401)
 const response = await fetch(`${base}${pathname}`, { headers: { "x-worker-id": "worker-1", "x-timestamp": timestamp,
  "x-signature": signature(secret, "GET", pathname, timestamp) } })
 assert.equal(response.status, 200)
 assert.equal((await response.json()).protocolVersion, 1)
 const raw = JSON.stringify({ operationId: "pair-1", assignmentId: assignment.id, fence: 1 })
 const bad = await fetch(`${base}/internal/v1/pairing`, { method: "POST", body: `${raw} `,
  headers: { "content-type": "application/json", "x-worker-id": "worker-1", "x-timestamp": timestamp,
   "x-signature": signature(secret, "POST", "/internal/v1/pairing", timestamp, raw) } })
 assert.equal(bad.status, 401)
})

test("unassigned worker allocation independently verifies gateway ownership", async (t) => {
 let remote = null
 const f = await fixture(t, { gateway: async (url) => url.endsWith("/assignment") ? { assignment: remote } : undefined })
 assert.equal(f.worker.capabilities().clean, true)
 const body = { operationId: "allocate-1", assignmentId: assignment.id, tenantId: assignment.tenantId, fence: 1 }
 await assert.rejects(f.worker.assign(body), { code: "STALE_ASSIGNMENT" })
 remote = assignment
 assert.equal((await f.worker.assign(body)).assigned, true)
 assert.equal(f.worker.capabilities().clean, false)
 assert.equal(f.starts, 0)
 const first = await f.worker.pairing({ operationId: "pair-1", assignmentId: assignment.id, fence: 1, fresh: true })
 assert.equal(first.qr, "offline-qr")
 assert.match(first.qrImage, /^data:image\/png;base64,/)
 assert.equal(f.starts, 1)
 await f.worker.pairing({ operationId: "pair-1", assignmentId: assignment.id, fence: 1, fresh: true })
 assert.equal(f.starts, 1)
 assert.throws(() => f.worker.qr({ assignmentId: "other-assignment", fence: 1 }), { code: "STALE_ASSIGNMENT" })
})

test("managed media requires owned origins and exact immutable byte metadata", async (t) => {
 const filename = path.join(__dirname, "fixtures", "image.png")
 const bytes = await fs.readFile(filename)
 const sha256 = createHash("sha256").update(bytes).digest("hex")
 let cleans = 0
 const staging = { async stage() { return { path: filename, size: bytes.length, mimetype: "image/png", metadata: {}, cleanup: async () => { cleans++ } } },
  async shutdown() {} }
 const f = await fixture(t, { staging })
 const body = { operationId: "inspect-1", assignmentId: assignment.id, tenantId: assignment.tenantId, fence: 1,
  mediaId: "media-1", type: "image", url: "https://gateway.example/internal/v1/media/media-1/content?grant=offline", expectedSize: bytes.length, expectedSha256: sha256 }
 await assert.rejects(f.worker.inspect({ ...body, url: "https://untrusted.example/image.png" }), { code: "INVALID_MEDIA_URL" })
 await assert.rejects(f.worker.inspect({ ...body, expectedSize: bytes.length + 1 }), { code: "MEDIA_INTEGRITY_FAILED" })
 const result = await f.worker.inspect(body)
 assert.equal(result.success, true)
 assert.equal(result.sha256, sha256)
 assert.equal(result.size, bytes.length)
 const previousCleans = cleans
 assert.deepEqual(await f.worker.inspect(body), result)
 assert.equal(cleans, previousCleans)
 await assert.rejects(f.worker.inspect({ ...body, operationId: "import-1", url: "http://example.com/image.png" }, true), { code: "INVALID_MEDIA_URL" })
})

test("media imports stream contiguous bounded parts without sending a WhatsApp message", async (t) => {
 const filename = path.join(__dirname, "fixtures", "image.png"), bytes = await fs.readFile(filename)
 const half = Math.floor(bytes.length / 2), uploaded = []
 const staging = { async stage() { return { path: filename, size: bytes.length, mimetype: "image/png", metadata: {}, cleanup: async () => {} } }, async shutdown() {} }
 const f = await fixture(t, { staging,
  gateway: async (url) => url.endsWith("/import-target") ? { mode: "multipart", parts: [
   { start: 0, size: half, url: "https://gateway.example/part/1", headers: {} },
   { start: half, size: bytes.length - half, url: "https://gateway.example/part/2", headers: {} }
  ] } : undefined,
  fetchImpl: async (_url, options) => { const chunks = []; for await (const chunk of options.body) chunks.push(chunk); const part = Buffer.concat(chunks); assert.equal(part.length, Number(options.headers["content-length"])); uploaded.push(part); return new Response(null, { status: 200 }) }
 })
 const result = await f.worker.inspect({ operationId: "multipart-import-1", assignmentId: assignment.id, tenantId: assignment.tenantId, fence: 1, mediaId: "media-1", type: "image", url: "https://example.com/image.png" }, true)
 assert.equal(result.success, true)
 assert.deepEqual(Buffer.concat(uploaded), bytes)
 assert.equal(uploaded.length, 2)
 await eventually(() => f.calls.some((call) => call.url.endsWith("/result") && call.body.success))
 assert.equal(f.sends, 0)
})

test("media integrity failure occurs before send authorization", async (t) => {
 const filename = path.join(__dirname, "fixtures", "image.png")
 const bytes = await fs.readFile(filename)
 const staging = { async stage() { return { path: filename, size: bytes.length, mimetype: "image/png", metadata: {}, cleanup: async () => {} } }, async shutdown() {} }
 const f = await fixture(t, { staging })
 await f.dispatch({ payload: { phone: "12025550123", type: "image", caption: "offline" }, media: {
  mediaId: "media-1", url: "https://gateway.example/internal/v1/media/media-1/content?grant=offline", sha256: "0".repeat(64), size: bytes.length
 } })
 await eventually(() => f.worker.debugSnapshot().jobs["job-1"].status === "failed")
 assert.equal(f.worker.debugSnapshot().jobs["job-1"].errorCode, "MEDIA_INTEGRITY_FAILED")
 assert.equal(f.sends, 0)
 assert.equal(f.calls.some((call) => call.url.endsWith("/send-start")), false)
})
