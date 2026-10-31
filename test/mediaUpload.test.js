const test = require("node:test")
const assert = require("node:assert/strict")
const { once } = require("node:events")
const fs = require("node:fs/promises")
const path = require("node:path")
const os = require("node:os")
const http = require("node:http")
const express = require("express")
const mediaUpload = require("../middleware/mediaUpload")
const { createMediaUpload } = mediaUpload

async function waitFor(check) {
 const deadline = Date.now() + 5000
 while (Date.now() < deadline) {
  const result = await check()
  if (result) return result
  await new Promise((resolve) => setTimeout(resolve, 20))
 }
 throw new Error("Timed out waiting for temporary upload cleanup")
}

async function isMissing(target) {
 try {
  await fs.access(target)
  return false
 } catch (error) {
  if (error.code === "ENOENT") return true
  throw error
 }
}

async function fixture(t, options = {}) {
 const requests = []
 const app = express()
 app.use(express.json())
 app.post("/send", createMediaUpload(options), async (req, res) => {
  const received = {
   body: { ...req.body },
   file: req.file,
   contents: req.file ? (await fs.readFile(req.file.path)).toString() : undefined
  }
  requests.push(received)
  if (options.failController) {
   await req.cleanupUpload()
   return res.status(400).json({ error: "Rejected by controller" })
  }
  res.json(received)
 })
 app.use((error, req, res, next) => {
  if (res.destroyed) return
  res.status(error.status || 500).json({ error: error.expose ? error.message : "Internal server error" })
 })
 const server = app.listen(0, "127.0.0.1")
 await once(server, "listening")
 t.after(() => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve())
  server.closeAllConnections()
 }))
 return { base: `http://127.0.0.1:${server.address().port}`, server, requests }
}

function multipart(parts) {
 const boundary = "test-baileys-upload-boundary"
 const body = parts.map(({ name, value, filename, type }) => {
  const fileHeader = filename === undefined ? "" : `; filename="${filename}"`
  const contentType = type ? `Content-Type: ${type}\r\n` : ""
  return `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${fileHeader}\r\n${contentType}\r\n${value}\r\n`
 }).join("") + `--${boundary}--\r\n`
 return { body, headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` } }
}

async function post(base, parts, headers = {}) {
 const request = multipart(parts)
 return fetch(`${base}/send`, {
  method: "POST", body: request.body, headers: { ...request.headers, ...headers }
 })
}

test("multipart media uploads stream to temporary files and retain JSON support", async (t) => {
 const { base, requests } = await fixture(t)

 await t.test("JSON request bodies pass through unchanged", async () => {
  const payload = { phone: "12025550123", type: "image", url: "https://example.com/photo.jpg" }
  const response = await fetch(`${base}/send`, {
   method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  })
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).body, payload)
  assert.equal(requests.at(-1).file, undefined)
 })

 await t.test("file contents, optional fields, and upload metadata reach the controller", async () => {
  const response = await post(base, [
   { name: "phone", value: "12025550123" },
   { name: "type", value: "image" },
   { name: "caption", value: "Picture from Postman" },
   { name: "file", filename: "holiday.jpg", type: "image/jpeg", value: "binary-data-123" },
   { name: "viewOnce", value: "false" }
  ])
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.contents, "binary-data-123")
  assert.deepEqual(result.body, {
   phone: "12025550123", type: "image", caption: "Picture from Postman", viewOnce: "false"
  })
  assert.equal(result.file.originalname, "holiday.jpg")
  assert.equal(result.file.mimetype, "image/jpeg")
  assert.equal(result.file.size, 15)
  assert.equal(path.relative(os.tmpdir(), result.file.path).startsWith(".."), false)
  assert.equal(path.basename(result.file.path), "media")
  await waitFor(() => isMissing(path.dirname(result.file.path)))
 })

 await t.test("client filenames cannot choose the disk path", async () => {
  const response = await post(base, [{ name: "file", filename: "../../auth/creds.json", value: "safe" }])
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.file.originalname, "creds.json")
  assert.equal(path.basename(result.file.path), "media")
  await waitFor(() => isMissing(path.dirname(result.file.path)))
 })

 await t.test("special field names cannot mutate the parsed body's prototype", async () => {
  const response = await post(base, [
   { name: "__proto__", value: "test" }, { name: "file", filename: "test", value: "safe" }
  ])
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(Object.hasOwn(result.body, "__proto__"), true)
  assert.equal(result.body.__proto__, "test")
  await waitFor(() => isMissing(path.dirname(result.file.path)))
 })
})

test("multipart upload errors are safe and do not invoke the controller", async (t) => {
 const { base, requests } = await fixture(t, { maxFileBytes: 16 })
 const file = { name: "file", filename: "test.bin", value: "safe" }
 const cases = [
  ["missing upload", [{ name: "phone", value: "12025550123" }], 400],
  ["empty upload", [{ ...file, value: "" }], 400],
  ["wrong file field", [{ ...file, name: "photo" }], 400],
  ["multiple uploads", [file, file], 400],
  ["duplicate fields", [{ name: "phone", value: "1" }, { name: "phone", value: "2" }, file], 400],
  ["file over byte limit", [{ ...file, value: "x".repeat(17) }], 413],
  ["field over byte limit", [{ name: "caption", value: "x".repeat(8193) }, file], 413],
  ["UTF-8 field over byte limit", [{ name: "caption", value: "😀".repeat(2049) }, file], 413],
  ["too many fields", [...Array.from({ length: 17 }, (_, i) => ({ name: `f${i}`, value: "v" })), file], 413],
  ["total field bytes over limit", [...Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, value: "x".repeat(7000) })), file], 413]
 ]
 for (const [name, parts, status] of cases) {
  await t.test(name, async () => {
   const response = await post(base, parts)
   assert.equal(response.status, status)
   const body = await response.json()
   assert.equal(typeof body.error, "string")
   assert.equal(body.error.includes(os.tmpdir()), false)
   assert.equal(requests.length, 0)
  })
 }

 await t.test("file exactly at the byte limit is accepted", async () => {
  const response = await post(base, [{ ...file, value: "x".repeat(16) }])
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.file.size, 16)
  await waitFor(() => isMissing(path.dirname(body.file.path)))
 })

 await t.test("missing multipart boundary is rejected", async () => {
  const response = await fetch(`${base}/send`, {
   method: "POST", headers: { "Content-Type": "multipart/form-data" }, body: "broken"
  })
  assert.equal(response.status, 400)
 })

 await t.test("unfinished multipart stream is rejected", async () => {
  const request = multipart([file])
  const response = await fetch(`${base}/send`, {
   method: "POST", headers: request.headers, body: request.body.slice(0, -40)
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error, "Invalid or incomplete multipart request")
 })

 await t.test("compressed multipart uploads are rejected", async () => {
  const response = await post(base, [file], { "Content-Encoding": "gzip" })
  assert.equal(response.status, 415)
 })
})

test("temporary upload cleanup is idempotent and works for controller rejection", async (t) => {
 const { base, requests } = await fixture(t, { failController: true })
 const response = await post(base, [{ name: "file", filename: "test.bin", value: "temporary" }])
 assert.equal(response.status, 400)
 assert.equal(requests.length, 1)
 assert.equal(await isMissing(path.dirname(requests[0].file.path)), true)
})

test("client cancellation removes the unfinished upload", async (t) => {
 const { base, requests } = await fixture(t)
 const before = new Set((await fs.readdir(os.tmpdir())).filter((entry) => entry.startsWith("baileys-upload-")))
 const boundary = "cancelled-upload"
 const request = http.request(`${base}/send`, {
  method: "POST", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` }
 })
 request.on("error", () => {})
 request.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cancelled.bin"\r\n\r\n`)
 request.write("unfinished upload")
 const created = await waitFor(async () => {
  const entries = await fs.readdir(os.tmpdir())
  return entries.find((entry) => entry.startsWith("baileys-upload-") && !before.has(entry))
 })
 request.destroy()
 await waitFor(() => isMissing(path.join(os.tmpdir(), created)))
 assert.equal(requests.length, 0)
})

test("invalid upload limit configuration is rejected", () => {
 for (const maxFileBytes of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER]) {
  assert.throws(() => createMediaUpload({ maxFileBytes }), TypeError)
 }
})
