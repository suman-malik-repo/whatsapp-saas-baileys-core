const test = require("node:test")
const assert = require("node:assert/strict")
const { once } = require("node:events")
const express = require("express")
const { createApp } = require("../app")

test("HTTP authentication, readiness, and JSON responses", async (t) => {
 const apiKey = "test-only-shared-key"
 let whatsapp = {
  state: "connecting",
  connected: false,
  reconnectAttempts: 0,
  nextRetryAt: null,
  lastDisconnectCode: null
 }
 const received = []
 const router = express.Router()
 router.post("/send", (req, res) => {
  received.push(req.body)
  res.json({ success: true })
 })

 const app = createApp({ apiKey, getConnectionStatus: () => ({ ...whatsapp }), messageRouter: router })
 const server = app.listen(0, "127.0.0.1")
 await once(server, "listening")
 t.after(() => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve())
  server.closeAllConnections()
 }))
 const base = `http://127.0.0.1:${server.address().port}`
 const headers = { "x-api-key": apiKey, "Content-Type": "application/json" }

 await t.test("ping reports not ready without requiring an API key", async () => {
  const response = await fetch(`${base}/ping`)
  assert.equal(response.status, 503)
  assert.equal(response.headers.get("cache-control"), "no-store")
  const body = await response.json()
  assert.equal(body.status, "not_ready")
  assert.deepEqual(body.whatsapp, whatsapp)
  assert.ok(Number.isFinite(Date.parse(body.time)))
 })

 await t.test("ping reports ready only after WhatsApp opens", async () => {
  whatsapp = { ...whatsapp, state: "connected", connected: true }
  const response = await fetch(`${base}/ping`)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).status, "ready")
 })

 await t.test("ping returns to 503 after a disconnect", async () => {
  whatsapp = { ...whatsapp, state: "reconnecting", connected: false, reconnectAttempts: 1 }
  const response = await fetch(`${base}/ping`)
  assert.equal(response.status, 503)
  assert.equal((await response.json()).whatsapp.state, "reconnecting")
 })

 await t.test("missing, incorrect, and same-length incorrect keys cannot invoke sending", async () => {
  for (const key of [undefined, "incorrect", "x".repeat(apiKey.length)]) {
   const response = await fetch(`${base}/api/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { "x-api-key": key } : {}) },
    body: JSON.stringify({ phone: "12025550123", message: "Hello" })
   })
   assert.equal(response.status, 401)
   assert.deepEqual(await response.json(), { success: false, error: "Invalid or missing API key" })
  }
  assert.equal(received.length, 0)
 })

 await t.test("API key must be in its header, not a query parameter", async () => {
  const response = await fetch(`${base}/api/send?apiKey=${apiKey}`, {
   method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
  })
  assert.equal(response.status, 401)
  assert.equal(received.length, 0)
 })

 await t.test("correct key authorizes the JSON request", async () => {
  const payload = { phone: "12025550123", message: "Hello" }
  const response = await fetch(`${base}/api/send`, { method: "POST", headers, body: JSON.stringify(payload) })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { success: true })
  assert.deepEqual(received, [payload])
  assert.equal(response.headers.get("access-control-allow-origin"), null)
 })

 await t.test("unauthenticated malformed JSON is rejected before parsing", async () => {
  const response = await fetch(`${base}/api/send`, {
   method: "POST", headers: { "Content-Type": "application/json" }, body: "{"
  })
  assert.equal(response.status, 401)
  assert.equal(received.length, 1)
 })

 await t.test("malformed JSON returns a stable JSON error", async () => {
  const response = await fetch(`${base}/api/send`, { method: "POST", headers, body: "{" })
  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { success: false, error: "Invalid JSON body" })
  assert.equal(received.length, 1)
 })

 await t.test("oversized requests return 413 without invoking sending", async () => {
  const response = await fetch(`${base}/api/send`, {
   method: "POST", headers, body: JSON.stringify({ message: "x".repeat(32768) })
  })
  assert.equal(response.status, 413)
  assert.deepEqual(await response.json(), { success: false, error: "Request body is too large" })
  assert.equal(received.length, 1)
 })

 await t.test("unsupported encoding returns a JSON 415", async () => {
  const response = await fetch(`${base}/api/send`, {
   method: "POST", headers: { ...headers, "Content-Encoding": "unsupported" }, body: "{}"
  })
  assert.equal(response.status, 415)
  assert.deepEqual(await response.json(), { success: false, error: "Unsupported request encoding" })
 })

 await t.test("unknown routes return JSON", async () => {
  const response = await fetch(`${base}/unknown`)
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { success: false, error: "Not found" })
 })
})

test("an explicitly empty API key is rejected at app creation", () => {
 assert.throws(() => createApp({ apiKey: "", getConnectionStatus: () => ({}), messageRouter: express.Router() }), /API key/)
})

test("standalone startup requires an environment API key when none is injected", () => {
 for (const API_KEY of [undefined, "", "   "]) {
  assert.throws(() => createApp({ env: { API_KEY }, getConnectionStatus: () => ({}),
   messageRouter: express.Router() }), /API_KEY must be configured/)
 }
})

test("managed HTTP starts without a standalone API key and keeps local ingress disabled", async (t) => {
 const managedWorker = {
  workerId: "offline-managed-worker", secret: "offline-worker-secret-with-at-least-32-bytes",
  getConnectionStatus: () => ({ state: "stopped", connected: false }),
  readiness: () => ({ ready: false, state: "unassigned" })
 }
 const app = createApp({ managedWorker, env: {}, apiKey: "" })
 const server = app.listen(0, "127.0.0.1")
 await once(server, "listening")
 t.after(() => new Promise((resolve) => {
  server.close(resolve)
  server.closeAllConnections()
 }))
 const base = `http://127.0.0.1:${server.address().port}`
 assert.equal((await fetch(`${base}/live`)).status, 200)
 assert.equal((await fetch(`${base}/internal/v1/capabilities`)).status, 401)
 assert.equal((await fetch(`${base}/api/send`, { method: "POST" })).status, 404)
 assert.equal((await fetch(`${base}/qr`)).status, 404)
})
