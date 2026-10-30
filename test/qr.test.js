const test = require("node:test")
const assert = require("node:assert/strict")
const { once } = require("node:events")
const express = require("express")
const { createQrRouter } = require("../routes/qrRoutes")

async function startTestServer(t, app) {
 const server = app.listen(0, "127.0.0.1")
 await once(server, "listening")
 t.after(() => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve())
  server.closeAllConnections()
 }))
 return `http://127.0.0.1:${server.address().port}`
}

function assertPngDataUri(value) {
 assert.match(value, /^data:image\/png;base64,/)
 const bytes = Buffer.from(value.slice("data:image/png;base64,".length), "base64")
 assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
 assert.ok(bytes.length > 100)
}

test("QR HTTP routes provide a protected pairing payload and a public HTML shell", async (t) => {
 const apiKey = "test-only-qr-static-key"
 const rawQr = '1@pairing-data,public-key,"</script><img src=x onerror=alert(1)>",secret'
 const calls = []
 let snapshot = {
  state: "qr_required",
  connected: false,
  qr: rawQr,
  generatedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 120000).toISOString()
 }
 let requestError = null
 const app = express()
 app.use("/qr", createQrRouter({
  apiKey,
  getQrStatus: () => ({ ...snapshot }),
  requestQr: async (options) => {
   calls.push(options)
   if (requestError) throw requestError
   return { ...snapshot }
  }
 }))
 app.use((error, req, res, next) => {
  if (res.headersSent) return next(error)
  if (error.type === "entity.parse.failed") {
   return res.status(400).json({ success: false, error: "Invalid JSON body" })
  }
  if (error.type === "entity.too.large") {
   return res.status(413).json({ success: false, error: "Request body is too large" })
  }
  res.status(500).json({ success: false, error: "Internal server error" })
 })
 const base = await startTestServer(t, app)
 const headers = { "x-api-key": apiKey, "Content-Type": "application/json" }

 await t.test("GET shows a shell that keeps the key and pairing data out of HTML", async () => {
  const response = await fetch(`${base}/qr`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get("content-type"), /text\/html/)
  assert.equal(response.headers.get("cache-control"), "no-store")
  assert.equal(response.headers.get("x-content-type-options"), "nosniff")
  const html = await response.text()
  assert.match(html, /api[ -]?key/i)
  assert.match(html, /\/qr\/assets\/qr\.js/)
  assert.match(html, /\/qr\/assets\/qr\.css/)
  assert.ok(!html.includes(apiKey))
  assert.ok(!html.includes(rawQr))
  assert.doesNotMatch(html, /(?:src|href)\s*=\s*["']https?:\/\//i)
  assert.equal(calls.length, 0)
 })

 await t.test("HEAD can retrieve the shell headers without a pairing action", async () => {
  const response = await fetch(`${base}/qr`, { method: "HEAD" })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), "")
  assert.equal(calls.length, 0)
 })

 await t.test("assets are served locally with the correct types", async () => {
  for (const [asset, contentType] of [["qr.js", /javascript/], ["qr.css", /text\/css/]]) {
   const response = await fetch(`${base}/qr/assets/${asset}`)
   assert.equal(response.status, 200)
   assert.match(response.headers.get("content-type"), contentType)
   assert.equal(response.headers.get("cache-control"), "no-store")
   assert.equal(response.headers.get("x-content-type-options"), "nosniff")
   const body = await response.text()
   assert.ok(body.length > 0)
   assert.ok(!body.includes(apiKey))
   assert.ok(!body.includes(rawQr))
  }
  assert.equal(calls.length, 0)
 })

 await t.test("status and refresh reject missing or incorrect API keys", async () => {
  for (const path of ["/qr/status", "/qr"]) {
   for (const key of [undefined, "wrong-key", "x".repeat(apiKey.length)]) {
    const response = await fetch(`${base}${path}`, {
     method: path === "/qr" ? "POST" : "GET",
     headers: { "Content-Type": "application/json", ...(key ? { "x-api-key": key } : {}) },
     ...(path === "/qr" ? { body: "{}" } : {})
    })
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { success: false, error: "Invalid or missing API key" })
    assert.equal(response.headers.get("cache-control"), "no-store")
   }
  }
  assert.equal(calls.length, 0)
 })

 await t.test("query parameters cannot supply the API key", async () => {
  for (const [path, method] of [["/qr", "POST"], ["/qr/status", "GET"]]) {
   const response = await fetch(`${base}${path}?apiKey=${apiKey}&x-api-key=${apiKey}`, { method })
   assert.equal(response.status, 401)
  }
  assert.equal(calls.length, 0)
 })

 await t.test("unauthenticated malformed JSON is rejected before parsing or refresh", async () => {
  const response = await fetch(`${base}/qr`, {
   method: "POST", headers: { "Content-Type": "application/json" }, body: "{"
  })
  assert.equal(response.status, 401)
  assert.equal(calls.length, 0)
 })

 await t.test("status returns the current QR without requesting a fresh code", async () => {
  const response = await fetch(`${base}/qr/status`, { headers })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.success, true)
  assert.equal(body.qr, rawQr)
  assert.equal(body.state, "qr_required")
  assert.equal(body.connected, false)
  assert.equal(body.generatedAt, snapshot.generatedAt)
  assert.equal(body.expiresAt, snapshot.expiresAt)
  assertPngDataUri(body.qrImage)
  assert.equal(calls.length, 0)
 })

 await t.test("POST preserves the exact QR text and returns a local PNG image", async () => {
  const response = await fetch(`${base}/qr`, { method: "POST", headers, body: "{}" })
  assert.equal(response.status, 200)
  assert.match(response.headers.get("content-type"), /application\/json/)
  assert.equal(response.headers.get("cache-control"), "no-store")
  const body = await response.json()
  assert.equal(body.success, true)
  assert.equal(body.qr, rawQr)
  assert.equal(body.generatedAt, snapshot.generatedAt)
  assert.equal(body.expiresAt, snapshot.expiresAt)
  assertPngDataUri(body.qrImage)
  assert.deepEqual(calls, [{ fresh: true }])
 })

 await t.test("an omitted POST body requests a fresh code", async () => {
  const response = await fetch(`${base}/qr`, { method: "POST", headers: { "x-api-key": apiKey } })
  assert.equal(response.status, 200)
  assert.deepEqual(calls.at(-1), { fresh: true })
 })

 await t.test("fresh false is forwarded and fresh true remains explicit", async () => {
  for (const fresh of [false, true]) {
   const response = await fetch(`${base}/qr`, { method: "POST", headers, body: JSON.stringify({ fresh }) })
   assert.equal(response.status, 200)
   assert.deepEqual(calls.at(-1), { fresh })
  }
 })

 await t.test("invalid bodies and fresh flags do not reach the lifecycle", async () => {
  const before = calls.length
  for (const body of ["null", "[]", "1", '"string"', "true", '{"fresh":"true"}', '{"fresh":1}', '{"fresh":null}']) {
   const response = await fetch(`${base}/qr`, { method: "POST", headers, body })
   assert.equal(response.status, 400, body)
   const payload = await response.json()
   assert.equal(payload.success, false)
   assert.equal(typeof payload.error, "string")
  }
  assert.equal(calls.length, before)
 })

 await t.test("malformed and oversized JSON do not reach the lifecycle", async () => {
  const before = calls.length
  const malformed = await fetch(`${base}/qr`, { method: "POST", headers, body: "{" })
  assert.equal(malformed.status, 400)
  assert.deepEqual(await malformed.json(), { success: false, error: "Invalid JSON body" })
  const oversized = await fetch(`${base}/qr`, {
   method: "POST", headers, body: JSON.stringify({ ignored: "x".repeat(2048) })
  })
  assert.equal(oversized.status, 413)
  assert.equal((await oversized.json()).success, false)
  assert.equal(calls.length, before)
 })

 await t.test("unsupported methods cannot request a code", async () => {
  const before = calls.length
  for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"]) {
   const response = await fetch(`${base}/qr`, { method, headers })
   assert.equal(response.status, 405)
   assert.equal(response.headers.get("allow"), "GET, HEAD, POST")
   assert.equal((await response.json()).success, false)
  }
  assert.equal(calls.length, before)
 })

 await t.test("pending and connected statuses have no stale QR", async () => {
  const before = calls.length
  for (const state of ["connecting", "reconnecting", "connected"]) {
   snapshot = { ...snapshot, state, connected: state === "connected", qr: state === "connected" ? rawQr : null }
   const response = await fetch(`${base}/qr/status`, { headers })
   assert.equal(response.status, 200)
   const body = await response.json()
   assert.equal(body.success, true)
   assert.equal(body.state, state)
   assert.equal(body.qr, null)
   assert.equal(body.qrImage, null)
  }
  assert.equal(calls.length, before)
 })

 await t.test("expired QR data is withheld", async () => {
  snapshot = { ...snapshot, state: "qr_required", connected: false, qr: rawQr, expiresAt: new Date(Date.now() - 1000).toISOString() }
  const response = await fetch(`${base}/qr/status`, { headers })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.qr, null)
  assert.equal(body.qrImage, null)
 })

 await t.test("offline states return 503 without old pairing data", async () => {
  const before = calls.length
  for (const state of ["stopped", "failed", "logged_out"]) {
   snapshot = { ...snapshot, state, connected: false, qr: rawQr, expiresAt: new Date(Date.now() + 120000).toISOString() }
   const response = await fetch(`${base}/qr/status`, { headers })
   assert.equal(response.status, 503)
   const body = await response.json()
   assert.equal(body.success, false)
   assert.equal(body.qr, null)
   assert.equal(body.qrImage, null)
   assert.equal(typeof body.error, "string")
  }
  assert.equal(calls.length, before)
 })

 await t.test("POST also suppresses QR data for an already connected account", async () => {
  snapshot = { ...snapshot, state: "connected", connected: true, qr: rawQr }
  const response = await fetch(`${base}/qr`, { method: "POST", headers, body: "{}" })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.success, true)
  assert.equal(body.connected, true)
  assert.equal(body.qr, null)
  assert.equal(body.qrImage, null)
 })

 await t.test("a lifecycle error does not reveal internal details", async () => {
  requestError = new Error("private-session-secret-that-must-not-be-exposed")
  const response = await fetch(`${base}/qr`, { method: "POST", headers, body: "{}" })
  assert.ok(response.status >= 500)
  const body = await response.json()
  assert.equal(body.success, false)
  assert.ok(!JSON.stringify(body).includes(requestError.message))
 })
})

test("createApp mounts QR routes with injected lifecycle functions", async (t) => {
 const { createApp } = require("../app")
 const requests = []
 const status = { state: "connecting", connected: false, qr: null, generatedAt: null, expiresAt: null }
 const app = createApp({
  apiKey: "integration-qr-key",
  getConnectionStatus: () => ({ state: "connecting", connected: false }),
  messageRouter: express.Router(),
  getQrStatus: () => ({ ...status }),
  requestQr: async (options) => {
   requests.push(options)
   return { ...status }
  }
 })
 const base = await startTestServer(t, app)
 const shell = await fetch(`${base}/qr`)
 assert.equal(shell.status, 200)
 const unauthenticated = await fetch(`${base}/qr`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: "{"
 })
 assert.equal(unauthenticated.status, 401)
 assert.equal(requests.length, 0)
 const response = await fetch(`${base}/qr`, {
  method: "POST", headers: { "x-api-key": "integration-qr-key", "Content-Type": "application/json" }, body: "{}"
 })
 assert.equal(response.status, 200)
 assert.equal((await response.json()).state, "connecting")
 assert.deepEqual(requests, [{ fresh: true }])
})
