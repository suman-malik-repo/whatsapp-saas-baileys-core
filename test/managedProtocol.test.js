const test = require("node:test")
const assert = require("node:assert/strict")
const { createGatewayClient, signature } = require("../services/managedProtocol")

const secret = "offline-protocol-secret-at-least-32-bytes"
function client(fetchImpl) {
 return createGatewayClient({ gatewayUrl: "https://gateway.example", workerId: "worker-1", secret,
  now: () => 1793533260000, fetchImpl })
}

test("gateway client signs the exact operation and reads bounded streamed JSON", async () => {
 const body = { eventId: "event-1" }
 const call = client(async (url, options) => {
  assert.equal(url.href, "https://gateway.example/internal/v1/jobs/job-1/events")
  assert.equal(options.redirect, "error")
  assert.equal(options.body, JSON.stringify(body))
  assert.equal(options.headers["x-signature"], signature(secret, "POST", url.pathname, "1793533260000", options.body))
  return new Response('{"accepted":true}')
 })
 assert.deepEqual(await call("/internal/v1/jobs/job-1/events", body), { accepted: true })
})

test("gateway client rejects other origins and non-protocol paths before fetching", async () => {
 let calls = 0
 const call = client(async () => { calls++; return new Response("{}") })
 for (const pathname of ["https://elsewhere.example/internal/v1/probe", "//elsewhere.example/internal/v1/probe", "/live", "/internal/v1/../../live"]) {
  await assert.rejects(call(pathname), /Invalid gateway operation path/)
 }
 assert.equal(calls, 0)
})

test("gateway client cancels oversized declared bodies without reading them", async () => {
 let cancelled = false, pulled = 0
 const call = client(async () => new Response(new ReadableStream({
  pull() { pulled++ }, cancel() { cancelled = true }
 }, { highWaterMark: 0 }), { headers: { "content-length": String(128 * 1024 + 1) } }))
 await assert.rejects(call("/internal/v1/workers/worker-1/assignment"), /exceeds limit/)
 assert.equal(cancelled, true)
 assert.equal(pulled, 0)
})

test("gateway client counts real bytes and cancels chunked overflow before buffering", async () => {
 let cancelled = false, pulled = 0
 const call = client(async () => new Response(new ReadableStream({
  pull(controller) { pulled++; controller.enqueue(new Uint8Array(8192)) },
  cancel() { cancelled = true }
 }, { highWaterMark: 0 })))
 await assert.rejects(call("/internal/v1/workers/worker-1/assignment"), /exceeds limit/)
 assert.equal(cancelled, true)
 assert.equal(pulled, 17)
})

test("gateway transport failures have a safe retry classification and rejected bodies are cancelled", async () => {
 await assert.rejects(client(async () => { throw new TypeError("offline") })("/internal/v1/workers/worker-1/assignment"),
  { code: "GATEWAY_UNAVAILABLE", status: 503 })
 let cancelled = false
 const call = client(async () => new Response(new ReadableStream({ cancel() { cancelled = true } }), { status: 401 }))
 await assert.rejects(call("/internal/v1/workers/worker-1/assignment"), { code: "GATEWAY_UNAVAILABLE" })
 assert.equal(cancelled, true)
})

test("interrupted gateway response bodies retain the transient retry classification", async () => {
 const call = client(async () => new Response(new ReadableStream({
  pull(controller) { controller.error(new Error("Connection closed during response")) }
 })))
 await assert.rejects(call("/internal/v1/workers/worker-1/assignment"), { code: "GATEWAY_UNAVAILABLE", status: 503 })
})
