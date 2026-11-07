const assert = require("node:assert/strict")
const { once } = require("node:events")
const test = require("node:test")
const { startServer } = require("../server")

function deferred() {
 let resolve
 const promise = new Promise((done) => { resolve = done })
 return { promise, resolve }
}

function connection() {
 const changes = new Set()
 const updates = new Set()
 let connected = false
 let sends = 0
 const active = deferred()
 const began = deferred()
 const state = () => ({ state: connected ? "connected" : "connecting", connected })
 const socket = { async sendMessage(jid, content, options) {
  sends++
  began.resolve()
  await active.promise
  return { key: { id: options.messageId } }
 } }
 return {
  changes, updates, active, began, stopped: false,
  get sends() { return sends },
  getSocket: () => connected ? socket : null,
  getConnectionStatus: state,
  subscribeConnection(listener) { changes.add(listener); listener(state()); return () => changes.delete(listener) },
  subscribeMessageUpdates(listener) { updates.add(listener); return () => updates.delete(listener) },
  async startWhatsApp() { connected = true; for (const listener of changes) listener(state()) },
  async stopWhatsApp() { this.stopped = true; connected = false }
 }
}

async function fixture(t, drainMs) {
 const manager = connection()
 const server = startServer({ port: 0, host: "127.0.0.1", connection: manager,
  workerOptions: { env: {}, config: { minIntervalMs: 0, drainMs }, generateMessageId: () => "OFFLINE-SHUTDOWN-ID" },
  appOptions: { apiKey: "test-shutdown-key" } })
 await once(server, "listening")
 await new Promise(setImmediate)
 t.after(async () => { manager.active.resolve(); await server.shutdown() })
 const base = `http://127.0.0.1:${server.address().port}`
 const send = () => fetch(`${base}/api/send`, { method: "POST",
  headers: { "Content-Type": "application/json", "x-api-key": "test-shutdown-key" },
  body: JSON.stringify({ phone: "12025550123", message: "offline fixture" }) })
 return { server, manager, send }
}

test("shutdown drains an active job before closing WhatsApp and saves sent status", async (t) => {
 const { server, manager, send } = await fixture(t, 1000)
 const accepted = await send()
 assert.equal(accepted.status, 202)
 const { jobId } = await accepted.json()
 await manager.began.promise
 const stopping = server.shutdown()
 assert.equal(server.messageWorker.readiness().ready, false)
 assert.equal(manager.stopped, false)
 assert.throws(() => server.messageWorker.queue.reserve(), { code: "WORKER_SHUTTING_DOWN" })
 manager.active.resolve()
 await stopping
 assert.equal(server.messageWorker.getJob(jobId).status, "sent")
 assert.equal(manager.stopped, true)
 assert.equal(manager.changes.size, 0)
 assert.equal(manager.updates.size, 0)
 assert.equal(server.shutdown(), stopping)
})

test("shutdown deadline marks active send unknown and queued jobs cancelled", async (t) => {
 const { server, manager, send } = await fixture(t, 20)
 const first = await (await send()).json()
 await manager.began.promise
 const second = await (await send()).json()
 const started = Date.now()
 await server.shutdown()
 assert.ok(Date.now() - started < 2000)
 assert.equal(server.messageWorker.getJob(first.jobId).status, "unknown")
 assert.equal(server.messageWorker.getJob(second.jobId).status, "cancelled")
 assert.equal(manager.sends, 1)
 assert.equal(manager.stopped, true)
 assert.equal(server.messageWorker.staging.stats().files, 0)
 manager.active.resolve()
})

test("shutdown before listening cannot start a late WhatsApp connection", async () => {
 const manager = connection()
 let starts = 0
 manager.startWhatsApp = async () => { starts++ }
 const server = startServer({ port: 0, host: "127.0.0.1", connection: manager,
  workerOptions: { env: {}, config: { drainMs: 0 } }, appOptions: { apiKey: "test-shutdown-key" } })
 await server.shutdown()
 await new Promise(setImmediate)
 assert.equal(starts, 0)
 assert.equal(manager.stopped, true)
 assert.equal(server.listening, false)
})

test("server uses its supplied PORT and API_KEY environment for standalone HTTP", async (t) => {
 const manager = connection()
 const previousPort = process.env.PORT
 let server
 try {
  process.env.PORT = "-1"
  server = startServer({ env: { PORT: "0", API_KEY: "offline-environment-key" },
   host: "127.0.0.1", connection: manager, workerOptions: { config: { drainMs: 0 } } })
 } finally {
  if (previousPort === undefined) delete process.env.PORT
  else process.env.PORT = previousPort
 }
 t.after(() => server.shutdown())
 await once(server, "listening")
 const base = `http://127.0.0.1:${server.address().port}`
 assert.equal((await fetch(`${base}/live`)).status, 200)
 assert.equal((await fetch(`${base}/api/queue/stats`)).status, 401)
 assert.equal((await fetch(`${base}/api/queue/stats`, {
  headers: { "x-api-key": "offline-environment-key" }
 })).status, 200)
})

test("invalid ports fail before starting a worker or network listener", () => {
 const manager = connection()
 for (const PORT of ["-1", "65536", "3000.5", "not-a-port", "", " 3000 "]) {
  assert.throws(() => startServer({ env: { PORT, API_KEY: "offline-environment-key" },
   connection: manager }), /PORT must be an integer/)
 }
 assert.equal(manager.changes.size, 0)
 assert.equal(manager.updates.size, 0)
})
