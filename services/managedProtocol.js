const { createHash, createHmac, timingSafeEqual } = require("node:crypto")

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
function managedError(status, code, message) {
 return Object.assign(new Error(message), { status, code, expose: true })
}
function validId(value, label = "ID") {
 if (typeof value !== "string" || !ID.test(value)) throw managedError(400, "INVALID_ID", `${label} is invalid`)
 return value
}
function signature(secret, method, pathname, timestamp, rawBody = "") {
 const digest = createHash("sha256").update(rawBody).digest("hex")
 return createHmac("sha256", secret).update(`${method.toUpperCase()}\n${pathname}\n${timestamp}\n${digest}`).digest("hex")
}
function createAuthenticator({ workerId, secret, now = Date.now }) {
 return (req, res, next) => {
  const timestamp = req.get("x-timestamp") || ""
  const supplied = req.get("x-signature") || ""
  if (req.get("x-worker-id") !== workerId || !/^\d{13}$/.test(timestamp) ||
      Math.abs(now() - Number(timestamp)) > 300000 || !/^[a-f0-9]{64}$/.test(supplied)) {
   return res.status(401).json({ error: "Invalid worker authentication" })
  }
  const pathname = new URL(req.originalUrl, "http://worker.invalid").pathname
  const expected = signature(secret, req.method, pathname, timestamp, req.rawBody || Buffer.alloc(0))
  if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(supplied, "hex"))) {
   return res.status(401).json({ error: "Invalid worker authentication" })
  }
  next()
 }
}
function createGatewayClient({ gatewayUrl, workerId, secret, fetchImpl = fetch, now = Date.now }) {
 const base = new URL(gatewayUrl)
 if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname))) throw new Error("GATEWAY_URL requires HTTPS")
 if (base.username || base.password || base.search || base.hash || base.pathname !== "/") throw new Error("GATEWAY_URL must be an origin")
 return async (pathname, body, method = "POST") => {
  const destination = new URL(pathname, base)
  if (destination.origin !== base.origin || !destination.pathname.startsWith("/internal/v1/")) throw new Error("Invalid gateway operation path")
  const raw = body === undefined ? "" : JSON.stringify(body)
  const timestamp = String(now())
  let response
  try { response = await fetchImpl(destination, {
   method, redirect: "error", signal: AbortSignal.timeout(15000),
   headers: { "content-type": "application/json", "x-worker-id": workerId, "x-timestamp": timestamp,
    "x-signature": signature(secret, method, destination.pathname, timestamp, raw) },
   ...(body === undefined ? {} : { body: raw })
  }) } catch { throw managedError(503, "GATEWAY_UNAVAILABLE", "Gateway could not be reached") }
  if (!response.ok) {
   await response.body?.cancel().catch(() => {})
   throw managedError(503, "GATEWAY_UNAVAILABLE", "Gateway rejected worker operation")
  }
  // Count actual bytes, including chunked responses, before buffering JSON.
  const maximum = 128 * 1024
  if (Number(response.headers.get("content-length")) > maximum) {
   await response.body?.cancel().catch(() => {})
   throw managedError(502, "INVALID_GATEWAY_RESPONSE", "Gateway response exceeds limit")
  }
  const reader = response.body?.getReader(), chunks = []
  let size = 0
  if (reader) try {
   while (true) {
    const part = await reader.read()
    if (part.done) break
    size += part.value.byteLength
    if (size > maximum) {
     await reader.cancel().catch(() => {})
     throw managedError(502, "INVALID_GATEWAY_RESPONSE", "Gateway response exceeds limit")
    }
    chunks.push(Buffer.from(part.value))
   }
  } catch (error) {
   if (error.code === "INVALID_GATEWAY_RESPONSE") throw error
   throw managedError(503, "GATEWAY_UNAVAILABLE", "Gateway response was interrupted")
  } finally { reader.releaseLock() }
  const text = Buffer.concat(chunks, size).toString("utf8")
  return text ? JSON.parse(text) : {}
 }
}
module.exports = { signature, validId, managedError, createAuthenticator, createGatewayClient }
