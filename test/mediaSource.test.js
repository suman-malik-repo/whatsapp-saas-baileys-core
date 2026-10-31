const assert = require("node:assert/strict")
const dns = require("node:dns")
const fs = require("node:fs")
const http = require("node:http")
const https = require("node:https")
const os = require("node:os")
const path = require("node:path")
const { EventEmitter } = require("node:events")
const { PassThrough } = require("node:stream")
const test = require("node:test")
const { prepareMediaSource, isPublicIp } = require("../services/mediaSource")

const sample = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name))
const PNG = sample("image.png")
const WEBP = sample("image.webp")
const MP4 = sample("video.mp4")
const OPUS = sample("voice.ogg")
const OGG = sample("audio-vorbis.ogg")

async function waitFor(check) {
 const deadline = Date.now() + 5000
 while (!check()) {
  if (Date.now() > deadline) throw new Error("Timed out waiting for media operation")
  await new Promise((resolve) => setImmediate(resolve))
 }
}

async function uploaded(t, bytes) {
 const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wa-media-test-"))
 t.after(() => fs.promises.rm(directory, { recursive: true, force: true }))
 const filename = path.join(directory, "owned-upload")
 await fs.promises.writeFile(filename, bytes)
 return { path: filename, originalname: "upload.bin", size: bytes.length }
}

async function collect(prepared) {
 const chunks = []
 try { for await (const chunk of prepared.stream) chunks.push(chunk) }
 finally { await prepared.cleanup() }
 return Buffer.concat(chunks)
}

function mockNetwork(t, replies, addresses = [{ address: "93.184.216.34", family: 4 }]) {
 const calls = []
 t.mock.method(dns.promises, "lookup", async (hostname, options) => {
  calls.push({ dns: hostname, options })
  return typeof addresses === "function" ? addresses(hostname) : addresses
 })
 const request = (url, options, callback) => {
  const req = new EventEmitter()
  req.destroyed = false
  req.destroy = (error) => {
   req.destroyed = true
   if (error) queueMicrotask(() => req.emit("error", error))
   return req
  }
  req.end = () => {
   const reply = replies.shift()
   calls.push({ url, options, req })
   queueMicrotask(() => {
    if (reply.error) { req.emit("error", reply.error); return }
    const res = new PassThrough()
    res.statusCode = reply.status || 200
    res.headers = reply.headers || {}
    calls.push({ res })
    callback(res)
    if (reply.chunks) {
     for (const chunk of reply.chunks) res.write(chunk)
     res.end()
    } else if (reply.hang) {
     if (reply.initial) res.write(reply.initial)
    } else res.end(reply.body || PNG)
   })
  }
  return req
 }
 t.mock.method(http, "request", request)
 t.mock.method(https, "request", request)
 return calls
}

test("media address policy blocks private, metadata, documentation, transition and mapped addresses", () => {
 for (const value of ["127.0.0.1", "0.0.0.0", "10.0.0.1", "100.100.100.200", "169.254.169.254",
  "172.16.1.2", "192.168.1.1", "192.0.2.3", "198.18.0.1", "198.51.100.1", "203.0.113.1",
  "224.0.0.1", "255.255.255.255", "::", "::1", "fc00::1", "fe80::1", "ff02::1",
  "::ffff:127.0.0.1", "::ffff:8.8.8.8", "64:ff9b::7f00:1", "2002:7f00:1::", "2001:db8::1", "2001::1", "3fff::1", "bad"]) {
  assert.equal(isPublicIp(value), false, value)
 }
 for (const value of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "2001:4860:4860::8888"]) {
  assert.equal(isPublicIp(value), true, value)
 }
})

test("owned uploaded images are sniffed and streamed without losing any bytes", async (t) => {
 const file = await uploaded(t, PNG)
 const prepared = await prepareMediaSource({ kind: "image", file, maxBytes: 1000 })
 assert.equal(prepared.mimetype, "image/png")
 assert.deepEqual(await collect(prepared), PNG)
 assert.equal(fs.existsSync(file.path), true, "the upload owner removes the file")
 await prepared.cleanup()
})

test("valid WebP stickers, MP4 videos and Opus voice notes use detected media types", async (t) => {
 for (const [kind, data, mime, requestedType] of [
  ["sticker", WEBP, "image/webp"], ["video", MP4, "video/mp4"],
  ["audio", OPUS, "audio/ogg; codecs=opus", "voice"]
 ]) {
  const prepared = await prepareMediaSource({ kind, requestedType, file: await uploaded(t, data), maxBytes: 10000 })
  assert.equal(prepared.mimetype, mime)
  assert.deepEqual(await collect(prepared), data)
 }
})

test("voice notes reject non-Opus audio and explicit MIME mismatches", async (t) => {
 await assert.rejects(prepareMediaSource({ kind: "audio", ptt: true,
  file: await uploaded(t, OGG), maxBytes: 10000 }), { status: 415 })
 await assert.rejects(prepareMediaSource({ kind: "image", mimetype: "image/jpeg", mimetypeExplicit: true,
  file: await uploaded(t, PNG), maxBytes: 1000 }), { status: 415 })
 await assert.rejects(prepareMediaSource({ kind: "sticker",
  file: await uploaded(t, PNG), maxBytes: 1000 }), { status: 415 })
})

test("documents preserve text and explicit MIME hints while recognized file types win", async (t) => {
 const text = Buffer.from("A short plain-text document\n")
 const prepared = await prepareMediaSource({ kind: "document", file: await uploaded(t, text),
  mimetype: "text/plain", mimetypeExplicit: true, maxBytes: 1000 })
 assert.equal(prepared.mimetype, "text/plain")
 assert.deepEqual(await collect(prepared), text)
 const png = await prepareMediaSource({ kind: "document", file: await uploaded(t, PNG),
  mimetype: "application/octet-stream", maxBytes: 1000 })
 assert.equal(png.mimetype, "image/png")
 assert.deepEqual(await collect(png), PNG)
 await assert.rejects(prepareMediaSource({ kind: "document", file: await uploaded(t, PNG),
  mimetype: "application/pdf", mimetypeExplicit: true, maxBytes: 1000 }), { status: 415 })
})

test("empty, oversized and unavailable uploaded files fail before sending", async (t) => {
 await assert.rejects(prepareMediaSource({ kind: "document", file: await uploaded(t, Buffer.alloc(0)), maxBytes: 1000 }), { status: 400 })
 await assert.rejects(prepareMediaSource({ kind: "image", file: await uploaded(t, PNG), maxBytes: 8 }), { status: 413 })
 await assert.rejects(prepareMediaSource({ kind: "document", file: { path: path.join(os.tmpdir(), "nonexistent-wa-media-file") }, maxBytes: 1000 }), { status: 400 })
})

test("remote downloads pin the validated DNS address and preserve the hostname", async (t) => {
 const calls = mockNetwork(t, [{ body: PNG, headers: { "content-type": "image/jpeg" } }])
 const prepared = await prepareMediaSource({ kind: "image", url: "https://media.example/file.png?token=test", maxBytes: 1000 })
 assert.deepEqual(await collect(prepared), PNG)
 const request = calls.find((call) => call.url)
 assert.equal(request.url.hostname, "media.example")
 assert.equal(request.options.agent, false)
 request.options.lookup("media.example", {}, (error, address, family) => {
  assert.equal(error, null)
  assert.equal(address, "93.184.216.34")
  assert.equal(family, 4)
 })
 request.options.lookup("media.example", { all: true }, (error, addresses) => {
  assert.equal(error, null)
  assert.deepEqual(addresses, [{ address: "93.184.216.34", family: 4 }])
 })
 assert.equal(calls.filter((call) => call.dns).length, 1)
 assert.equal(prepared.mimetype, "image/png")
 assert.equal(request.req.destroyed, true)
})

test("every DNS result and redirect is checked before connecting", async (t) => {
 const calls = mockNetwork(t, [], [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }])
 await assert.rejects(prepareMediaSource({ kind: "image", url: "https://media.example/file", maxBytes: 1000 }), { status: 400 })
 assert.equal(calls.filter((call) => call.url).length, 0)
})

test("private literal URLs, credentials, nonstandard ports and unsupported schemes never connect", async (t) => {
 const calls = mockNetwork(t, [])
 for (const url of ["http://127.1/file", "http://2130706433/file", "http://[::ffff:127.0.0.1]/file", "http://169.254.169.254/latest",
  "https://user:password@media.example/file", "https://media.example:8443/file", "file:///tmp/file", "ftp://media.example/file"]) {
  await assert.rejects(prepareMediaSource({ kind: "image", url, maxBytes: 1000 }), { status: 400 })
 }
 assert.equal(calls.length, 0)
})

test("redirects to a private address are rejected and the old response is destroyed", async (t) => {
 const calls = mockNetwork(t, [{ status: 302, headers: { location: "http://127.0.0.1/secret" } }])
 await assert.rejects(prepareMediaSource({ kind: "image", url: "https://media.example/file", maxBytes: 1000 }), { status: 400 })
 assert.equal(calls.filter((call) => call.url).length, 1)
 assert.equal(calls.find((call) => call.res).res.destroyed, true)
})

test("public redirects re-resolve and use fresh headers without credentials", async (t) => {
 const calls = mockNetwork(t, [{ status: 307, headers: { location: "https://cdn.example/image" } }, { body: PNG }])
 const prepared = await prepareMediaSource({ kind: "image", url: "https://media.example/file", maxBytes: 1000 })
 assert.deepEqual(await collect(prepared), PNG)
 assert.deepEqual(calls.filter((call) => call.dns).map((call) => call.dns), ["media.example", "cdn.example"])
 for (const { options } of calls.filter((call) => call.url)) {
  assert.equal(options.headers.Authorization, undefined)
  assert.equal(options.headers.Cookie, undefined)
 }
})

test("remote declared and actual size limits and empty bodies are enforced", async (t) => {
 const calls = mockNetwork(t, [
  { headers: { "content-length": "1000000" }, body: PNG },
  { body: Buffer.alloc(5000, "x") },
  { headers: { "content-length": "0" }, body: Buffer.alloc(0) },
  { body: Buffer.alloc(0) }
 ])
 for (const status of [413, 413, 400, 400]) {
  await assert.rejects(prepareMediaSource({ kind: "document", url: "https://media.example/file", maxBytes: 1000 }), { status })
 }
 assert.ok(calls.filter((call) => call.res).every((call) => call.res.destroyed))
})

test("HTTP failures, compressed bodies and HTML responses produce controlled generic errors", async (t) => {
 mockNetwork(t, [
  { status: 404, body: Buffer.from("private details") },
  { headers: { "content-encoding": "gzip" }, body: PNG },
  { headers: { "content-type": "text/html" }, body: Buffer.from("<html>Forbidden</html>") },
  { body: Buffer.from(" <!DOCTYPE html><html>Forbidden</html>") },
  { error: new Error("private TLS or URL details") }
 ])
 for (const status of [502, 415, 415, 415, 502]) {
  await assert.rejects(prepareMediaSource({ kind: "document", url: "https://media.example/secret", maxBytes: 1000 }),
   (error) => error.status === status && error.expose === true && !/private|secret/.test(error.message))
 }
})

test("cancellation aborts a pending download and cleanup can be repeated", async (t) => {
 const calls = mockNetwork(t, [{ hang: true }])
 const controller = new AbortController()
 const pending = prepareMediaSource({ kind: "image", url: "https://media.example/file", maxBytes: 1000 }, { signal: controller.signal })
 await new Promise((resolve) => setImmediate(resolve))
 controller.abort()
 await assert.rejects(pending, { status: 400, message: "Media request was cancelled" })
 assert.ok(calls.filter((call) => call.req).every((call) => call.req.destroyed))
 assert.ok(calls.filter((call) => call.res).every((call) => call.res.destroyed))
})

test("a valid prefix cannot bypass the size cap before media preparation completes", async (t) => {
 const calls = mockNetwork(t, [{ hang: true, initial: PNG }])
 const pending = prepareMediaSource({ kind: "image", url: "https://media.example/file", maxBytes: 1000 })
 const rejected = assert.rejects(pending, { status: 413, expose: true })
 await waitFor(() => calls.some((call) => call.res))
 calls.find((call) => call.res).res.write(Buffer.alloc(1500))
 await rejected
 assert.ok(calls.filter((call) => call.req).every((call) => call.req.destroyed))
})

function fakeDeadlines(t) {
 const active = new Set()
 t.mock.method(global, "setTimeout", (callback, delay) => {
  const timer = { callback, delay, unref() {} }
  active.add(timer)
  return timer
 })
 t.mock.method(global, "clearTimeout", (timer) => active.delete(timer))
 return active
}

test("the headers deadline also bounds DNS resolution and releases every timer", async (t) => {
 const active = fakeDeadlines(t)
 t.mock.method(dns.promises, "lookup", () => new Promise(() => {}))
 const pending = prepareMediaSource({ kind: "image", url: "https://media.example/file", maxBytes: 1000 })
 const rejected = assert.rejects(pending, { status: 504, expose: true })
 await new Promise((resolve) => setImmediate(resolve))
 const headers = [...active].find((timer) => timer.delay === 10_000)
 assert.ok(headers)
 headers.callback()
 await rejected
 assert.equal(active.size, 0)
})

test("the total download deadline aborts a stalled download before sending and releases resources", async (t) => {
 const active = fakeDeadlines(t)
 const calls = mockNetwork(t, [{ hang: true, initial: PNG }])
 const pending = prepareMediaSource({ kind: "image", url: "https://media.example/file", maxBytes: 1000 })
 const rejected = assert.rejects(pending, { status: 504, expose: true })
 await waitFor(() => calls.some((call) => call.res) && active.size === 1)
 assert.equal(active.size, 1)
 ;[...active][0].callback()
 await rejected
 assert.equal(active.size, 0)
 assert.ok(calls.filter((call) => call.req).every((call) => call.req.destroyed))
 assert.ok(calls.filter((call) => call.res).every((call) => call.res.destroyed))
})

test("incomplete downloads and MIME codec mismatches fail before returning a sendable stream", async (t) => {
 mockNetwork(t, [
  { body: PNG, headers: { "content-length": String(PNG.length + 5) } },
  { body: OPUS }
 ])
 await assert.rejects(prepareMediaSource({ kind: "image", url: "https://media.example/file", maxBytes: 1000 }), { status: 502 })
 await assert.rejects(prepareMediaSource({ kind: "audio", url: "https://media.example/file", maxBytes: 1000,
  mimetype: "audio/ogg; codecs=vorbis", mimetypeExplicit: true }), { status: 415 })
})

test("remote temporary media is removed after success, invalid contents and cancellation", async (t) => {
 const directories = []
 const realMkdtemp = fs.promises.mkdtemp.bind(fs.promises)
 t.mock.method(fs.promises, "mkdtemp", async (...args) => {
  const directory = await realMkdtemp(...args)
  if (path.basename(directory).startsWith("baileys-media-")) directories.push(directory)
  return directory
 })
 const calls = mockNetwork(t, [{ body: PNG }, { body: Buffer.from("not an image") }, { hang: true, initial: PNG }])
 const prepared = await prepareMediaSource({ kind: "image", url: "https://media.example/file", maxBytes: 1000 })
 assert.equal(fs.existsSync(directories[0]), true)
 await collect(prepared)
 assert.equal(fs.existsSync(directories[0]), false)
 await assert.rejects(prepareMediaSource({ kind: "image", url: "https://media.example/file", maxBytes: 1000 }), { status: 415 })
 assert.equal(fs.existsSync(directories[1]), false)
 const controller = new AbortController()
 const pending = prepareMediaSource({ kind: "image", url: "https://media.example/file", maxBytes: 1000 }, { signal: controller.signal })
 const rejected = assert.rejects(pending, { status: 400 })
 await waitFor(() => directories.length === 3)
 controller.abort()
 await rejected
 assert.equal(fs.existsSync(directories[2]), false)
 assert.ok(calls.filter((call) => call.res).every((call) => call.res.destroyed))
})

test("valid codec and Office hints work when detection only identifies a generic format", async (t) => {
 const mp3 = await prepareMediaSource({ kind: "audio", file: await uploaded(t, sample("audio.mp3")),
  mimetype: "audio/mpeg; codecs=mp3", mimetypeExplicit: true, maxBytes: 10000 })
 assert.equal(mp3.mimetype, "audio/mpeg")
 await collect(mp3)
 const cfb = Buffer.alloc(512)
 Buffer.from("d0cf11e0a1b11ae1", "hex").copy(cfb)
 const office = await prepareMediaSource({ kind: "document", file: await uploaded(t, cfb),
  mimetype: "application/msword", mimetypeExplicit: true, maxBytes: 1000 })
 assert.equal(office.mimetype, "application/msword")
 await collect(office)
})

test("cleanup waits for the uploaded file descriptor and is safe before consumption", async (t) => {
 const file = await uploaded(t, PNG)
 const prepared = await prepareMediaSource({ kind: "image", file, maxBytes: 1000 })
 await Promise.all([prepared.cleanup(), prepared.cleanup()])
 assert.equal(prepared.stream.destroyed, true)
 await fs.promises.unlink(file.path)
 assert.equal(fs.existsSync(file.path), false)
})
