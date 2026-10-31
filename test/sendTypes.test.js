const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { once } = require("node:events")
const { Readable } = require("node:stream")
const test = require("node:test")
const { createApp } = require("../app")
const { createMessageRouter } = require("../routes/messageRoutes")
const { createSendMessage } = require("../controllers/sendMessage")
const mediaUpload = require("../middleware/mediaUpload")
const { buildMessagePayload } = require("../utils/messagePayload")

const API_KEY = "offline-send-integration-key"
const PHONE = "+1 (202) 555-0123"
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=", "base64")
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(24)])
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(12)])
const OPUS = Buffer.alloc(80)
OPUS.write("OggS", 0)
OPUS.write("OpusHead", 28)

async function fixture(t, options = {}) {
 const calls = []
 const uploads = []
 const sock = options.sock || {
  async sendMessage(jid, content, sendOptions) {
   const chunks = []
   for (const value of Object.values(content)) {
    if (value?.stream) for await (const chunk of value.stream) chunks.push(chunk)
   }
   calls.push({ jid, content, sendOptions, bytes: Buffer.concat(chunks) })
   return { key: { id: "OFFLINE-MESSAGE-ID" } }
  }
 }
 const controller = createSendMessage({
  getSocket: options.getSocket || (() => sock),
  ...(options.prepareMediaSource ? { prepareMediaSource: options.prepareMediaSource } : {})
 })
 const app = createApp({
  apiKey: API_KEY,
  getConnectionStatus: () => ({ connected: true, state: "connected" }),
  messageRouter: createMessageRouter({
   sendMessage: controller,
   mediaUpload(req, res, next) {
    mediaUpload(req, res, (error) => {
     if (req.file) uploads.push(req.file.path)
     next(error)
    })
   }
  })
 })
 const server = app.listen(0, "127.0.0.1")
 await once(server, "listening")
 t.after(() => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve())
  server.closeAllConnections()
 }))
 const url = `http://127.0.0.1:${server.address().port}/api/send`
 return {
  calls, uploads, url,
  json(body, headers = {}) {
   return fetch(url, { method: "POST", headers: { "x-api-key": API_KEY, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) })
  },
  upload(type, bytes = PNG, name = "photo.png", mime = "application/octet-stream", fields = {}) {
   const body = new FormData()
   body.set("phone", PHONE)
   body.set("type", type)
   body.set("file", new Blob([bytes], { type: mime }), name)
   for (const [key, value] of Object.entries(fields)) body.set(key, value)
   return fetch(url, { method: "POST", headers: { "x-api-key": API_KEY }, body })
  }
 }
}

test("all JSON message types reach the socket through authenticated POST", async (t) => {
 const sources = []
 const f = await fixture(t, {
  async prepareMediaSource(media) {
   const source = { media, cleaned: false }
   sources.push(source)
   return { stream: Readable.from([Buffer.from("offline media")]), mimetype: media.mimetype,
    async cleanup() { source.cleaned = true } }
  }
 })
 const bodies = [
  { message: "Hello" },
  { type: "image", url: "https://example.com/photo.png", caption: "Photo", viewOnce: false },
  { type: "video", url: "https://example.com/clip.mp4", gifPlayback: false },
  { type: "audio", url: "https://example.com/audio.mp3", ptt: false, seconds: 0 },
  { type: "voice", url: "https://example.com/voice.opus", seconds: 12 },
  { type: "document", url: "https://example.com/invoice.pdf", fileName: "invoice.pdf" },
  { type: "sticker", url: "https://example.com/sticker.webp", isAnimated: false },
  { type: "location", location: { latitude: 0, longitude: 0, name: "Origin" } },
  { type: "contacts", contacts: [{ name: "Alex Example", phone: "12025550124" }] },
  { type: "poll", poll: { name: "Choose", options: ["A", "B"], selectableCount: 2 } }
 ]
 for (const body of bodies) await t.test(body.type || "legacy text", async () => {
  const response = await f.json({ phone: PHONE, ...body })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { success: true, phone: PHONE, messageId: "OFFLINE-MESSAGE-ID" })
  const call = f.calls.at(-1)
  assert.equal(call.jid, "12025550123@s.whatsapp.net")
  const media = sources.at(-1)
  if (["image", "video", "audio", "voice", "document", "sticker"].includes(body.type)) {
   assert.equal(media.cleaned, true, "resources close before the response")
   assert.equal(call.bytes.toString(), "offline media")
   assert.deepEqual(call.sendOptions, { mediaUploadTimeoutMs: 60000 })
   assert.equal(media.media.requestedType, body.type)
  } else assert.equal(call.sendOptions, undefined)
 })
 assert.equal(f.calls.length, 10)
 assert.equal(sources.length, 6)
 assert.equal(f.calls[1].content.viewOnce, false)
 assert.equal(f.calls[2].content.gifPlayback, false)
 assert.equal(f.calls[3].content.ptt, false)
 assert.equal(f.calls[3].content.seconds, 0)
 assert.equal(f.calls[4].content.ptt, true)
 assert.equal(f.calls[6].content.isAnimated, false)
 assert.equal(f.calls[7].content.location.degreesLatitude, 0)
 assert.match(f.calls[8].content.contacts.contacts[0].vcard, /waid=12025550124/)
 assert.deepEqual(f.calls[9].content.poll.values, ["A", "B"])
})

test("real multipart media is detected, streamed intact and removed before responding", async (t) => {
 const f = await fixture(t)
 for (const [type, bytes, name, mimetype, fields] of [
  ["image", PNG, "photo.png", "image/png", { caption: "Photo", viewOnce: "false" }],
  ["video", MP4, "clip.mp4", "video/mp4", { gifPlayback: "false" }],
  ["audio", OPUS, "audio.opus", "audio/ogg; codecs=opus", { ptt: "false", seconds: "0" }],
  ["voice", OPUS, "voice.opus", "audio/ogg; codecs=opus", { seconds: "12" }],
  ["document", Buffer.from("Invoice content\n"), "invoice.txt", "text/plain", { caption: "Invoice" }],
  ["sticker", WEBP, "sticker.webp", "image/webp", { isAnimated: "false" }]
 ]) await t.test(type, async () => {
  const response = await f.upload(type, bytes, name, "application/octet-stream", fields)
  assert.equal(response.status, 200, JSON.stringify(await response.json()))
  const call = f.calls.at(-1)
  assert.deepEqual(call.bytes, bytes)
  assert.equal(call.content.mimetype, mimetype)
  assert.equal(fs.existsSync(path.dirname(f.uploads.at(-1))), false)
  if (type === "document") assert.equal(call.content.fileName, "invoice.txt")
  if (type === "voice") assert.equal(call.content.ptt, true)
 })
})

test("authentication and validation prevent media preparation and sends", async (t) => {
 let preparations = 0
 const f = await fixture(t, { prepareMediaSource: async () => { preparations++; throw new Error("must not run") } })
 const image = { phone: PHONE, type: "image", url: "https://example.com/photo.png" }
 const denied = await f.json(image, { "x-api-key": "wrong" })
 assert.equal(denied.status, 401)
 const multipart = new FormData()
 multipart.set("file", new Blob([PNG]), "photo.png")
 const unauthorizedUpload = await fetch(f.url, { method: "POST", body: multipart })
 assert.equal(unauthorizedUpload.status, 401)
 assert.equal(f.uploads.length, 0)
 for (const body of [
  { ...image, phone: "invalid" }, { ...image, url: "file:///tmp/photo.png" },
  { ...image, fileName: "irrelevant.png" }, { phone: PHONE, type: "poll", poll: { name: "Choose", options: ["same", "SAME"] } }
 ]) assert.equal((await f.json(body)).status, 400)
 assert.equal(preparations, 0)
 assert.equal(f.calls.length, 0)
})

test("disconnected requests avoid remote media retrieval", async (t) => {
 let preparations = 0
 const f = await fixture(t, { getSocket: () => null,
  prepareMediaSource: async () => { preparations++; throw new Error("must not run") } })
 const response = await f.json({ phone: PHONE, type: "image", url: "https://example.com/photo.png" })
 assert.equal(response.status, 503)
 assert.equal(preparations, 0)
 assert.equal(f.calls.length, 0)
})

test("losing readiness while preparing media closes the source without sending", async (t) => {
 let cleaned = false
 let sends = 0
 let current = { sendMessage: async () => { sends++ } }
 const f = await fixture(t, { getSocket: () => current, prepareMediaSource: async () => {
  current = null
  return { stream: Readable.from([PNG]), mimetype: "image/png", cleanup: async () => { cleaned = true } }
 } })
 const response = await f.json({ phone: PHONE, type: "image", url: "https://example.com/photo.png" })
 assert.equal(response.status, 503)
 assert.equal(cleaned, true)
 assert.equal(sends, 0)
})

test("invalid media and failed sends remove uploaded files", async (t) => {
 for (const [name, options, bytes, fields, status] of [
  ["invalid options", {}, PNG, { unexpected: "value" }, 400],
  ["invalid bytes", {}, Buffer.from("not an image"), {}, 415],
  ["send failure", { sock: { sendMessage: async () => { throw new Error("private internal details") } } }, PNG, {}, 502]
 ]) await t.test(name, async (t) => {
  const f = await fixture(t, options)
  const response = await f.upload("image", bytes, "photo.png", "image/png", fields)
  assert.equal(response.status, status)
  assert.equal((await response.json()).error.includes("private internal details"), false)
  assert.equal(fs.existsSync(path.dirname(f.uploads.at(-1))), false)
 })
})

test("controlled media retrieval and stream errors retain their HTTP status", async (t) => {
 for (const status of [413, 504]) await t.test(String(status), async (t) => {
  const f = await fixture(t, { prepareMediaSource: async () => {
   throw Object.assign(new Error("Controlled media failure"), { status, expose: true })
  } })
  const response = await f.json({ phone: PHONE, type: "image", url: "https://example.com/photo.png" })
  assert.equal(response.status, status)
  assert.deepEqual(await response.json(), { success: false, error: "Controlled media failure" })
 })
 let cleaned = false
 const f = await fixture(t, { prepareMediaSource: async () => ({
  stream: Readable.from((async function* () {
   yield PNG
   throw Object.assign(new Error("Media file exceeds the size limit"), { status: 413, expose: true })
  })()),
  mimetype: "image/png", cleanup: async () => { cleaned = true }
 }) })
 const response = await f.json({ phone: PHONE, type: "image", url: "https://example.com/photo.png" })
 assert.equal(response.status, 413)
 assert.equal(cleaned, true)
 assert.equal(f.calls.length, 0)
})

test("client cancellation during preparation prevents sending and closes resources", { timeout: 5000 }, async (t) => {
 let began, finish, onCleaned
 const started = new Promise((resolve) => { began = resolve })
 const release = new Promise((resolve) => { finish = resolve })
 const cleaned = new Promise((resolve) => { onCleaned = resolve })
 const f = await fixture(t, { prepareMediaSource: async (_media, { signal }) => {
  began(signal)
  await release
  return { stream: Readable.from([PNG]), mimetype: "image/png", cleanup: async () => { onCleaned() } }
 } })
 const abort = new AbortController()
 const request = fetch(f.url, { method: "POST", signal: abort.signal,
  headers: { "x-api-key": API_KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ phone: PHONE, type: "image", url: "https://example.com/photo.png" }) })
 const failed = assert.rejects(request, { name: "AbortError" })
 const signal = await started
 const cancelled = once(signal, "abort")
 abort.abort()
 await failed
 await cancelled
 finish()
 await cleaned
 assert.equal(f.calls.length, 0)
})

test("installed Baileys serializes locations, contact cards and both poll modes offline", async () => {
 const { generateWAMessageContent, proto } = require("@whiskeysockets/baileys")
 const roundTrip = async (body) => {
  const { content } = buildMessagePayload({ phone: PHONE, ...body })
  const message = await generateWAMessageContent(content, {})
  return proto.Message.decode(proto.Message.encode(message).finish())
 }
 const location = await roundTrip({ type: "location", location: { latitude: -22.5, longitude: 88.3, name: "Place" } })
 assert.equal(location.locationMessage.degreesLatitude, -22.5)
 assert.equal(location.locationMessage.name, "Place")
 const contact = { name: "Alex; Example", phone: "12025550124", email: "alex@example.com" }
 const single = await roundTrip({ type: "contacts", contacts: [contact] })
 assert.match(single.contactMessage.vcard, /FN:Alex\\; Example/)
 const multiple = await roundTrip({ type: "contacts", contacts: [contact, { name: "Other", phone: "12025550125" }] })
 assert.equal(multiple.contactsArrayMessage.contacts.length, 2)
 for (const count of [1, 2]) {
  const poll = await roundTrip({ type: "poll", poll: { name: "Choose", options: ["A", "B"], selectableCount: count } })
  const creation = count === 1 ? poll.pollCreationMessageV3 : poll.pollCreationMessage
  assert.equal(creation.selectableOptionsCount, count)
  assert.deepEqual(creation.options.map(({ optionName }) => optionName), ["A", "B"])
  assert.equal(poll.messageContextInfo.messageSecret.length, 32)
 }
})

test("Postman JSON examples match the implemented request schema", () => {
 const collection = require("../postman/Baileys-WhatsApp.postman_collection.json")
 assert.equal(collection.item.length, 11)
 for (const item of collection.item) {
  assert.equal(item.request.method, "POST")
  assert.equal(item.request.url, "{{baseUrl}}/api/send")
  assert.ok(item.request.header.some(({ key, value }) => key === "x-api-key" && value === "{{apiKey}}"))
  if (item.request.body.mode === "raw") {
   const body = JSON.parse(item.request.body.raw.replaceAll("{{phone}}", "12025550123"))
   assert.equal(buildMessagePayload(body).jid, "12025550123@s.whatsapp.net")
  } else assert.equal(item.request.header.some(({ key }) => key.toLowerCase() === "content-type"), false)
 }
})
