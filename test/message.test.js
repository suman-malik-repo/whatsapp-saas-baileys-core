const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const vm = require("node:vm")
const formatPhone = require("../utils/formatPhone")

function loadModule(relativePath, mocks) {
 const source = fs.readFileSync(path.join(__dirname, relativePath), "utf8")
 const module = { exports: {} }
 const compile = vm.runInThisContext(`(function(require, module, exports) {\n${source}\n})`)
 compile((name) => {
  if (Object.hasOwn(mocks, name)) return mocks[name]
  throw new Error(`Unexpected import: ${name}`)
 }, module, module.exports)
 return module.exports
}

function loadController(getSocket) {
 return loadModule("../controllers/sendMessage.js", {
  "../config/socket": { getSocket },
  "../utils/formatPhone": formatPhone
 })
}

function response() {
 return {
  statusCode: 200,
  status(code) { this.statusCode = code; return this },
  json(body) { this.body = body; return this }
 }
}

test("phone formatting accepts international digits and display punctuation", () => {
 for (const phone of ["12025550123", "+1 (202) 555-0123", "  +91 98765 43210  "]) {
  assert.equal(formatPhone(phone), `${phone.replace(/\D/g, "")}@s.whatsapp.net`)
 }
 assert.equal(formatPhone("1234567"), "1234567@s.whatsapp.net")
 assert.equal(formatPhone("123456789012345"), "123456789012345@s.whatsapp.net")
})

test("phone formatting rejects malformed, local-prefix and non-string values", () => {
 for (const phone of [undefined, null, 12025550123, {}, [], "", "  ", "abc", "1-800-FLOWERS",
  "12025550123@s.whatsapp.net", "123@g.us", "0123456789", "0012025550123", "123456",
  "1234567890123456", "1+2025550123", "++12025550123", "1202/5550123", "----"]) {
  assert.throws(() => formatPhone(phone), TypeError)
 }
})

test("invalid request bodies never send and return validation errors", async () => {
 let sends = 0
 const controller = loadController(() => ({ sendMessage: async () => { sends++ } }))
 const invalidBodies = [undefined, null, [], "text", 123, new Date(), {},
  { phone: 12025550123, message: "hello" }, { phone: "12025550123", message: 12 },
  { phone: "12025550123", message: {} }, { phone: "12025550123", message: " \n\t" },
  { phone: "12025550123", message: "x".repeat(4097) }, { phone: "invalid", message: "hello" },
  { phone: "", message: "hello" }, { phone: "0123456789", message: "hello" }]

 for (const body of invalidBodies) {
  const res = response()
  await controller({ body }, res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.success, false)
  assert.equal(typeof res.body.error, "string")
 }
 assert.equal(sends, 0)
})

test("disconnected WhatsApp returns 503", async () => {
 const res = response()
 await loadController(() => null)({ body: { phone: "12025550123", message: "hello" } }, res)
 assert.equal(res.statusCode, 503)
 assert.deepEqual(res.body, { success: false, error: "WhatsApp is not connected" })
})

test("successful send normalizes phone, preserves message and returns the message ID", async () => {
 const calls = []
 const sock = { sendMessage: async (...args) => { calls.push(args); return { key: { id: "message-123" } } } }
 const body = { phone: "+1 (202) 555-0123", message: "  hello\n " }
 const res = response()
 await loadController(() => sock)({ body }, res)
 assert.deepEqual(calls, [["12025550123@s.whatsapp.net", { text: body.message }]])
 assert.equal(res.statusCode, 200)
 assert.deepEqual(res.body, { success: true, phone: body.phone, messageId: "message-123" })
})

test("maximum length message is accepted and missing result ID is safe", async () => {
 const sock = { sendMessage: async () => undefined }
 const res = response()
 await loadController(() => sock)({ body: { phone: "12025550123", message: "x".repeat(4096) } }, res)
 assert.equal(res.statusCode, 200)
 assert.deepEqual(res.body, { success: true, phone: "12025550123" })
})

test("send failure returns a generic 502 without exposing internal errors", async () => {
 const sock = { sendMessage: async () => { throw new Error("secret session details") } }
 const res = response()
 await loadController(() => sock)({ body: { phone: "12025550123", message: "hello" } }, res)
 assert.equal(res.statusCode, 502)
 assert.deepEqual(res.body, { success: false, error: "Failed to send WhatsApp message" })
})

test("a connection lost during sending returns 503", async () => {
 let current
 const sock = { sendMessage: async () => { current = null; throw new Error("connection closed") } }
 current = sock
 const res = response()
 await loadController(() => current)({ body: { phone: "12025550123", message: "hello" } }, res)
 assert.equal(res.statusCode, 503)
 assert.deepEqual(res.body, { success: false, error: "WhatsApp is not connected" })
})

test("send route only permits POST and never sends for other HTTP methods", async (t) => {
 const express = require("express")
 let sends = 0
 const router = loadModule("../routes/messageRoutes.js", {
  express,
  "../controllers/sendMessage": (req, res) => { sends++; res.json({ success: true }) }
 })
 const app = express()
 app.use("/api", router)
 const server = app.listen(0, "127.0.0.1")
 await new Promise((resolve, reject) => {
  server.once("listening", resolve)
  server.once("error", reject)
 })
 t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
 const url = `http://127.0.0.1:${server.address().port}/api/send?phone=12025550123&message=hello`

 for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
  const result = await fetch(url, { method })
  assert.equal(result.status, 405, method)
  assert.equal(result.headers.get("allow"), "POST", method)
  if (method !== "HEAD") {
   assert.deepEqual(await result.json(), { success: false, error: "Method not allowed. Use POST /api/send" })
  }
 }
 assert.equal(sends, 0)

 const post = await fetch(url, { method: "POST" })
 assert.equal(post.status, 200)
 assert.equal(sends, 1)
})
