const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const http = require("node:http")
const { once } = require("node:events")
const test = require("node:test")
const { createApp } = require("../app")
const { createMessageWorker } = require("../services/messageWorker")
const { createMessageRouter } = require("../routes/messageRoutes")
const mediaUpload = require("../middleware/mediaUpload")
const { prepareMediaSource } = require("../services/mediaSource")

const API_KEY = "offline-queue-http-test-key"
const PHONE = "+1 (202) 555-0123"
const PNG = fs.readFileSync(path.join(__dirname, "fixtures", "image.png"))
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function waitFor(check) {
 const deadline = Date.now() + 4000
 while (true) {
  const value = await check()
  if (value) return value
  if (Date.now() > deadline) throw new Error("Timed out waiting for queued HTTP operation")
  await pause(5)
 }
}

async function fixture(t, options = {}) {
 const calls = [], rawUploads = [], stagedFiles = []
 const connectionListeners = new Set(), updateListeners = new Set()
 let connected = options.connected !== false
 let state = connected ? "connected" : "reconnecting"
 let serial = 0
 const sock = {
  user: { id: "offline-user@s.whatsapp.net" },
  async sendMessage(jid, content, sendOptions) {
   const call = { jid, content, sendOptions, bytes: Buffer.alloc(0) }
   calls.push(call)
   if (options.sendMessage) return options.sendMessage(call)
   const chunks = []
   for (const value of Object.values(content)) {
    if (value?.stream) for await (const chunk of value.stream) chunks.push(chunk)
   }
   call.bytes = Buffer.concat(chunks)
   return { key: { id: sendOptions.messageId } }
  }
 }
 const connection = {
  getSocket: () => connected ? sock : null,
  getConnectionStatus: () => ({ connected, state }),
  subscribeConnection(listener) {
   connectionListeners.add(listener)
   listener(connection.getConnectionStatus())
   return () => connectionListeners.delete(listener)
  },
  subscribeMessageUpdates(listener) { updateListeners.add(listener); return () => updateListeners.delete(listener) }
 }
 const worker = createMessageWorker({
  connection, env: options.env || {},
  config: { minIntervalMs: 0, burstCapacity: 100, refillPerSecond: 100,
   httpWaitMs: 50, drainMs: 0, retryBaseMs: 5, retryMaxMs: 10, retryJitter: 0,
   ...options.config },
  generateMessageId: () => `TEST_WA_${++serial}`,
  ...(options.prepareMediaSource ? { prepareMediaSource: options.prepareMediaSource } : {})
 })
 const stage = worker.staging.stage
 worker.staging.stage = async (...args) => {
  const staged = await stage(...args)
  stagedFiles.push(staged.path)
  return staged
 }
 const app = createApp({ apiKey: API_KEY, worker,
  getQrStatus: () => ({ connected, state, qr: null }), requestQr: async () => ({ connected, state, qr: null }),
  messageRouter: createMessageRouter({ worker, mediaUpload(req, res, next) {
   mediaUpload(req, res, (error) => { if (req.file) rawUploads.push(req.file.path); next(error) })
  } })
 })
 const server = app.listen(0, "127.0.0.1")
 await once(server, "listening")
 t.after(async () => {
  await worker.shutdown({ drainMs: 0 })
  await new Promise((resolve, reject) => {
   server.close((error) => error ? reject(error) : resolve())
   server.closeAllConnections()
  })
 })
 const baseUrl = `http://127.0.0.1:${server.address().port}`
 const f = {
  worker, calls, rawUploads, stagedFiles, baseUrl, connectionListeners, updateListeners,
  connect(value = true, nextState) {
   connected = value
   state = nextState || (value ? "connected" : "reconnecting")
   for (const listener of connectionListeners) listener(connection.getConnectionStatus())
  },
  acknowledge(messageId, status) { for (const listener of updateListeners) listener({ messageId, status }) },
  request(route, options = {}, authenticated = true) {
   return fetch(baseUrl + route, { ...options,
    headers: { ...(authenticated ? { "x-api-key": API_KEY } : {}), ...options.headers } })
  },
  json(body = { phone: PHONE, message: "Hello from queue" }, query = "", options = {}) {
   return f.request(`/api/send${query}`, { method: "POST", ...options,
    headers: { "Content-Type": "application/json", ...options.headers }, body: JSON.stringify(body) })
  },
  upload(bytes = PNG, fields = {}) {
   const form = new FormData()
   form.set("phone", PHONE)
   form.set("type", "image")
   form.set("file", new Blob([bytes], { type: "image/png" }), "photo.png")
   for (const [key, value] of Object.entries(fields)) form.set(key, value)
   return f.request("/api/send", { method: "POST", body: form })
  },
  async job(id) {
   const response = await f.request(`/api/messages/${id}`)
   assert.equal(response.status, 200)
   return (await response.json()).job
  },
  async status(id, status) {
   return waitFor(async () => {
    const job = await f.job(id)
    return job.status === status ? job : null
   })
  }
 }
 return f
}

test("POST queues with 202 and Location, then authenticated status follows sent and acknowledgement updates", async (t) => {
 const f = await fixture(t)
 const message = "private message text that must not appear in status"
 const response = await f.json({ phone: PHONE, message })
 assert.equal(response.status, 202)
 const accepted = await response.json()
 assert.equal(accepted.success, true)
 assert.equal(accepted.status, "queued")
 assert.match(accepted.jobId, /^[A-Za-z0-9_-]{1,128}$/)
 assert.equal(accepted.statusUrl, `/api/messages/${accepted.jobId}`)
 assert.equal(response.headers.get("location"), accepted.statusUrl)
 const sent = await f.status(accepted.jobId, "sent")
 assert.equal(sent.attempts, 1)
 assert.equal(sent.messageId, "TEST_WA_1")
 assert.ok(Number.isFinite(Date.parse(sent.createdAt)))
 assert.ok(Number.isFinite(Date.parse(sent.sentAt)))
 assert.equal(f.calls[0].jid, "12025550123@s.whatsapp.net")
 assert.equal(f.calls[0].content.text, message)
 f.acknowledge(sent.messageId, "read")
 const read = await f.status(accepted.jobId, "read")
 f.acknowledge(sent.messageId, "delivered")
 assert.equal((await f.job(accepted.jobId)).status, "read")
 const serialized = JSON.stringify(read)
 for (const secret of [PHONE, "12025550123", message, API_KEY, "recipient", "payload"]) assert.equal(serialized.includes(secret), false)
 assert.equal((await f.request(accepted.statusUrl, {}, false)).status, 401)
})

test("offline multipart jobs own validated media after HTTP response and remove all files after sending", async (t) => {
 const f = await fixture(t, { connected: false })
 const response = await f.upload()
 assert.equal(response.status, 202, JSON.stringify(await response.clone().json()))
 const accepted = await response.json()
 assert.equal(f.calls.length, 0)
 assert.equal((await f.job(accepted.jobId)).status, "queued")
 assert.equal(f.rawUploads.length, 1)
 assert.equal(fs.existsSync(f.rawUploads[0]), false, "request ownership ends before the 202 response")
 assert.equal(f.stagedFiles.length, 1)
 assert.equal(fs.existsSync(f.stagedFiles[0]), true, "the queue has a separate validated copy")
 assert.equal(f.worker.stats().media.files, 1)
 assert.equal(f.worker.stats().activeUploads, 0)
 assert.equal(JSON.stringify(accepted).includes(path.dirname(f.stagedFiles[0])), false)
 f.connect()
 await f.status(accepted.jobId, "sent")
 assert.deepEqual(f.calls[0].bytes, PNG)
 assert.equal(f.calls[0].content.mimetype, "image/png")
 await waitFor(() => f.worker.stats().media.files === 0)
 assert.equal(fs.existsSync(f.stagedFiles[0]), false)
 assert.equal(f.worker.stats().media.reservedBytes, 0)
})

test("errors after a socket send starts become unknown and are never automatically retried", async (t) => {
 const f = await fixture(t, { sendMessage: async () => {
  throw Object.assign(new Error("private transport payload and credentials"), { safeToRetry: true, code: "ECONNRESET" })
 } })
 const response = await f.json()
 assert.equal(response.status, 202)
 const { jobId } = await response.json()
 const unknown = await f.status(jobId, "unknown")
 assert.deepEqual(unknown.error, { code: "AMBIGUOUS_SEND_OUTCOME", retryable: false })
 await pause(40)
 assert.equal(f.calls.length, 1)
 assert.equal(unknown.attempts, 1)
 assert.equal(JSON.stringify(unknown).includes("credentials"), false)
 assert.equal(f.worker.stats().unknownOutcomeJobs, 1)
})

test("temporary disconnection pauses queued requests and reconnection resumes FIFO", async (t) => {
 const f = await fixture(t, { connected: false })
 const ids = []
 for (const message of ["first", "second", "third"]) {
  const response = await f.json({ phone: PHONE, message })
  assert.equal(response.status, 202)
  ids.push((await response.json()).jobId)
 }
 await pause(20)
 assert.equal(f.calls.length, 0)
 assert.equal(f.worker.stats().pendingJobs, 3)
 assert.equal((await f.job(ids[0])).attempts, 0)
 f.connect()
 for (const id of ids) await f.status(id, "sent")
 assert.deepEqual(f.calls.map((call) => call.content.text), ["first", "second", "third"])
 assert.equal(f.worker.stats().successfulSends, 3)
})

test("authentication and invalid input cannot create jobs or begin media preparation", async (t) => {
 let preparations = 0
 const f = await fixture(t, { prepareMediaSource: async () => { preparations++; throw new Error("must not prepare") } })
 const image = { phone: PHONE, type: "image", url: "https://example.com/photo.png" }
 assert.equal((await f.json(image, "", { headers: { "x-api-key": "wrong" } })).status, 401)
 const form = new FormData()
 form.set("file", new Blob([PNG]), "photo.png")
 assert.equal((await f.request("/api/send", { method: "POST", body: form }, false)).status, 401)
 for (const body of [{ ...image, phone: "invalid" }, { ...image, url: "file:///private.png" },
  { phone: PHONE, message: "" }, { phone: PHONE, message: "hello", unknown: true }]) {
  assert.equal((await f.json(body)).status, 400)
 }
 const malformed = await f.request("/api/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" })
 assert.equal(malformed.status, 400)
 const unsupported = await f.request("/api/send", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "hello" })
 assert.equal(unsupported.status, 415)
 assert.equal(preparations, 0)
 assert.equal(f.rawUploads.length, 0)
 assert.equal(f.calls.length, 0)
 assert.equal(f.worker.stats().retainedStatuses, 0)
 assert.equal(f.worker.stats().occupiedSlots, 0)
})

test("full queues reject multipart before parsing and preserve authentication precedence", async (t) => {
 const f = await fixture(t, { connected: false, config: { maxPending: 1 } })
 assert.equal((await f.json()).status, 202)
 const headers = { "Content-Type": "multipart/form-data; boundary=invalid" }
 const rejected = await f.request("/api/send", { method: "POST", headers, body: "not even valid multipart" })
 assert.equal(rejected.status, 429)
 assert.equal(rejected.headers.get("retry-after"), "1")
 assert.equal((await rejected.json()).code, "QUEUE_FULL")
 assert.equal((await f.request("/api/send", { method: "POST", headers, body: "not multipart" }, false)).status, 401)
 assert.equal(f.rawUploads.length, 0)
 assert.equal(f.worker.stats().media.files, 0)
 assert.equal(f.worker.stats().activeUploads, 0)
 assert.equal(f.worker.stats().pendingJobs, 1)
})

test("simultaneous HTTP admissions accept exactly the configured number and backpressure the rest", async (t) => {
 const f = await fixture(t, { connected: false, config: { maxPending: 5 } })
 const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => f.json({ phone: PHONE, message: `request ${i}` })))
 const accepted = responses.filter((response) => response.status === 202)
 const rejected = responses.filter((response) => response.status === 429)
 assert.equal(accepted.length, 5)
 assert.equal(rejected.length, 7)
 const bodies = await Promise.all(accepted.map((response) => response.json()))
 assert.equal(new Set(bodies.map((body) => body.jobId)).size, 5)
 for (const response of rejected) assert.equal((await response.json()).code, "QUEUE_FULL")
 assert.equal(f.worker.stats().pendingJobs, 5)
 assert.equal(f.worker.stats().occupiedSlots, 5)
 assert.equal(f.worker.stats().reservations, 0)
})

test("upload ingress remains bounded while another request is preparing its media", async (t) => {
 let release, started = false
 const gate = new Promise((resolve) => { release = resolve })
 const f = await fixture(t, { connected: false, config: { maxUploads: 1 },
  prepareMediaSource: async (media, options) => {
   started = true
   await Promise.race([gate, new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })
   })])
   return prepareMediaSource(media, options)
  } })
 const pending = f.upload()
 await waitFor(() => started)
 try {
  const rejected = await f.upload()
  assert.equal(rejected.status, 429)
  assert.equal((await rejected.json()).code, "UPLOAD_CAPACITY_FULL")
  assert.equal(f.rawUploads.length, 1, "the second request never reaches the multipart parser")
  assert.equal(f.worker.stats().activeUploads, 1)
 } finally { release() }
 const accepted = await pending
 assert.equal(accepted.status, 202)
 await accepted.json()
 assert.equal(f.worker.stats().activeUploads, 0)
 assert.equal(f.worker.stats().reservations, 0)
})

test("a rejected upload keeps its ingress slot until slow raw-file cleanup finishes", async (t) => {
 const f = await fixture(t, { connected: false })
 let release, cleaning = false
 const gate = new Promise((resolve) => { release = resolve })
 const remove = fs.promises.rm.bind(fs.promises)
 t.mock.method(fs.promises, "rm", async (target, options) => {
  if (path.basename(target).startsWith("baileys-upload-")) { cleaning = true; await gate }
  return remove(target, options)
 })
 const pending = f.upload(Buffer.from("invalid image"))
 await waitFor(() => cleaning)
 try {
  assert.equal(f.worker.stats().activeUploads, 1)
  const rejected = await f.upload()
  assert.equal(rejected.status, 429)
 } finally { release() }
 assert.equal((await pending).status, 415)
 await waitFor(() => f.worker.stats().activeUploads === 0)
})

test("a compatibility wait failure still returns the already accepted job ID", async (t) => {
 const f = await fixture(t, { connected: false })
 f.worker.waitForJob = async () => { throw new Error("internal waiting failure") }
 const response = await f.json(undefined, "?wait=true")
 assert.equal(response.status, 202)
 const body = await response.json()
 assert.equal(body.success, true)
 assert.equal((await f.job(body.jobId)).status, "queued")
 assert.equal(f.worker.stats().pendingJobs, 1)
})

test("worker shutdown aborts incomplete multipart requests and awaits raw-file cleanup", { timeout: 5000 }, async (t) => {
 const f = await fixture(t, { connected: false })
 const directories = []
 const makeDirectory = fs.promises.mkdtemp.bind(fs.promises)
 t.mock.method(fs.promises, "mkdtemp", async (...args) => {
  const directory = await makeDirectory(...args)
  if (path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith("baileys-upload-")) directories.push(directory)
  return directory
 })
 const boundary = "shutdown-incomplete-upload"
 const request = http.request(`${f.baseUrl}/api/send`, { method: "POST", headers: {
  "x-api-key": API_KEY, "Content-Type": `multipart/form-data; boundary=${boundary}`
 } })
 request.on("error", () => {})
 request.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="partial.png"\r\nContent-Type: image/png\r\n\r\n`)
 request.write(PNG)
 await waitFor(() => directories.length === 1)
 assert.equal(f.worker.stats().activeUploads, 1)
 await f.worker.shutdown({ drainMs: 0 })
 request.destroy()
 assert.equal(fs.existsSync(directories[0]), false)
 assert.equal(f.worker.stats().activeUploads, 0)
 assert.equal(f.worker.stats().occupiedSlots, 0)
})

test("job IDs and query parameters are strictly validated without creating new work", async (t) => {
 const f = await fixture(t, { connected: false })
 for (const route of ["/api/messages/bad%20id", "/api/messages/a%2Fb", `/api/messages/${"x".repeat(129)}`,
  "/api/messages/-", "/api/messages/missing?extra=true", "/api/queue/stats?extra=true"]) {
  const response = await f.request(route)
  assert.equal(response.status, 400, route)
 }
 assert.equal((await f.request("/api/messages/missing")).status, 404)
 for (const query of ["?wait=maybe", "?unexpected=true", "?wait=true&wait=false", "?wait[x]=true"]) {
  assert.equal((await f.json(undefined, query)).status, 400, query)
 }
 const getSend = await f.request("/api/send")
 assert.equal(getSend.status, 405)
 assert.equal(getSend.headers.get("allow"), "POST")
 assert.equal(f.worker.stats().retainedStatuses, 0)
 assert.equal(f.worker.stats().occupiedSlots, 0)
})

test("public liveness and readiness reveal no message data while queue metrics require authentication", async (t) => {
 const f = await fixture(t)
 assert.equal((await f.request("/live", {}, false)).status, 200)
 assert.equal((await f.request("/ready", {}, false)).status, 200)
 assert.equal((await f.request("/ping", {}, false)).status, 200)
 assert.equal((await f.request("/api/queue/stats", {}, false)).status, 401)
 f.connect(false)
 const privateText = "secret queue content never present in metrics"
 await f.json({ phone: PHONE, message: privateText })
 for (const [route, status] of [["/live", 200], ["/ready", 503], ["/ping", 503]]) {
  const response = await f.request(route, {}, false)
  assert.equal(response.status, status)
  const body = await response.text()
  for (const secret of [PHONE, "12025550123", privateText, API_KEY, "qr", "token"]) assert.equal(body.includes(secret), false)
 }
 const metricsResponse = await f.request("/api/queue/stats")
 assert.equal(metricsResponse.status, 200)
 const metrics = await metricsResponse.json()
 assert.equal(metrics.queue.pendingJobs, 1)
 assert.equal(metrics.queue.durable, false)
 assert.equal(metrics.queue.sessions[0].state, "reconnecting")
 for (const secret of [PHONE, "12025550123", privateText, API_KEY, "recipient", "payload"]) assert.equal(JSON.stringify(metrics).includes(secret), false)
})

test("wait=true and QUEUE_API_MODE=wait retain the successful synchronous response shape", async (t) => {
 for (const [name, options, query] of [["query", {}, "?wait=true"],
  ["environment", { env: { QUEUE_API_MODE: "wait" } }, ""]]) await t.test(name, async (t) => {
  const f = await fixture(t, options)
  const response = await f.json(undefined, query)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.success, true)
  assert.equal(body.phone, PHONE)
  assert.equal(body.status, "sent")
  assert.equal(body.messageId, "TEST_WA_1")
  assert.equal(response.headers.get("location"), `/api/messages/${body.jobId}`)
  assert.equal((await f.job(body.jobId)).status, "sent")
 })
})

test("a bounded wait times out with the same queued job and explicit wait=false overrides wait mode", async (t) => {
 const f = await fixture(t, { connected: false, env: { QUEUE_API_MODE: "wait" } })
 const waiting = await f.json()
 assert.equal(waiting.status, 202)
 const accepted = await waiting.json()
 assert.equal(accepted.status, "queued")
 assert.equal((await f.job(accepted.jobId)).attempts, 0)
 const immediate = await f.json({ phone: PHONE, message: "second" }, "?wait=false")
 assert.equal(immediate.status, 202)
 const second = await immediate.json()
 assert.notEqual(accepted.jobId, second.jobId)
 f.connect()
 await f.status(accepted.jobId, "sent")
 await f.status(second.jobId, "sent")
 assert.equal(f.calls.length, 2)
})

test("a disconnected HTTP caller cannot cancel a job already accepted for asynchronous processing", async (t) => {
 const f = await fixture(t, { connected: false, config: { httpWaitMs: 100 } })
 let accepted
 const accept = f.worker.accept
 f.worker.accept = async (...args) => { accepted = await accept(...args); return accepted }
 const controller = new AbortController()
 const request = f.json(undefined, "?wait=true", { signal: controller.signal })
 const rejected = assert.rejects(request, { name: "AbortError" })
 await waitFor(() => accepted)
 controller.abort()
 await rejected
 f.connect()
 await f.status(accepted.jobId, "sent")
 assert.equal(f.calls.length, 1)
 assert.equal((await f.job(accepted.jobId)).attempts, 1)
})

test("graceful shutdown cancels queued media and removes its files without claiming success", async (t) => {
 const f = await fixture(t, { connected: false })
 const response = await f.upload()
 assert.equal(response.status, 202)
 const { jobId } = await response.json()
 assert.equal(fs.existsSync(f.stagedFiles[0]), true)
 await f.worker.shutdown({ drainMs: 0 })
 const job = await f.job(jobId)
 assert.equal(job.status, "cancelled")
 assert.equal(job.attempts, 0)
 assert.equal(job.error.code, "WORKER_SHUTDOWN")
 assert.equal(f.calls.length, 0)
 assert.equal(fs.existsSync(f.stagedFiles[0]), false)
 assert.equal(f.worker.stats().media.files, 0)
 assert.equal(f.connectionListeners.size, 0)
 assert.equal(f.updateListeners.size, 0)
 assert.equal((await f.request("/ready", {}, false)).status, 503)
 assert.equal((await f.json()).status, 503)
})

test("media validation and upstream failure reject before acceptance and clean request files", async (t) => {
 const invalid = await fixture(t, { connected: false })
 const response = await invalid.upload(Buffer.from("not actually a PNG"))
 assert.equal(response.status, 415)
 assert.equal(invalid.rawUploads.length, 1)
 assert.equal(fs.existsSync(invalid.rawUploads[0]), false)
 assert.equal(invalid.worker.stats().retainedStatuses, 0)
 assert.equal(invalid.worker.stats().occupiedSlots, 0)
 assert.equal(invalid.worker.stats().media.files, 0)
 const upstream = await fixture(t, { connected: false, prepareMediaSource: async () => {
  throw Object.assign(new Error("Media download timed out"), { status: 504, expose: true })
 } })
 const failed = await upstream.json({ phone: PHONE, type: "image", url: "https://example.com/photo.png" })
 assert.equal(failed.status, 504)
 assert.equal(upstream.worker.stats().retainedStatuses, 0)
 assert.equal(upstream.worker.stats().occupiedSlots, 0)
 assert.equal(upstream.worker.stats().media.reservedBytes, 0)
})
