const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { Readable, PassThrough } = require("node:stream")
const test = require("node:test")
const { createMediaStaging } = require("../services/mediaStaging")

const fileMedia = (maxBytes = 100) => ({ kind: "image", maxBytes, file: { path: "request-scoped-upload" } })
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function waitFor(check) {
 const deadline = Date.now() + 3000
 while (!check()) {
  if (Date.now() > deadline) throw new Error("Timed out waiting for staging cleanup")
  await pause(5)
 }
}

function fixture(t, options = {}, bytes = Buffer.from("validated media")) {
 const prepared = []
 const staging = createMediaStaging({
  ...options,
  prepareMediaSource: options.prepareMediaSource || (async (media, { signal }) => {
   const result = { media, signal, cleaned: 0, stream: Readable.from([bytes]),
    mimetype: "image/png", metadata: { width: 1, height: 1 } }
   result.cleanup = async () => { result.cleaned++; result.stream.destroy() }
   prepared.push(result)
   return result
  })
 })
 t.after(() => staging.shutdown())
 return { staging, prepared }
}

async function collect(stream) {
 const chunks = []
 for await (const chunk of stream) chunks.push(chunk)
 return Buffer.concat(chunks)
}

test("staging validates configuration and source descriptors", async () => {
 for (const options of [{ maxBytes: 0 }, { maxFiles: -1 }, { ttlMs: NaN }, { prepareMediaSource: true }]) {
  assert.throws(() => createMediaStaging(options), TypeError)
 }
 const staging = createMediaStaging()
 try {
  for (const media of [null, {}, { maxBytes: 5 }, { ...fileMedia(), url: "https://example.com/file" }]) {
   await assert.rejects(staging.stage(media), { status: 400, code: "MEDIA_STAGING_INVALID" })
  }
  assert.equal(staging.stats().files, 0)
 } finally { await staging.shutdown() }
})

test("fully validated bytes are copied into independent queue ownership before returning", async (t) => {
 const bytes = Buffer.from("independent immutable media")
 const { staging, prepared } = fixture(t, {}, bytes)
 const staged = await staging.stage(fileMedia())
 assert.equal(prepared[0].cleaned, 1)
 assert.equal(staged.mimetype, "image/png")
 assert.deepEqual(staged.metadata, { width: 1, height: 1 })
 assert.equal(staged.size, bytes.length)
 assert.equal(path.dirname(path.dirname(staged.path)), path.resolve(os.tmpdir()))
 assert.ok(path.basename(path.dirname(staged.path)).startsWith("baileys-stage-"))
 assert.deepEqual(await collect(staged.open()), bytes)
 assert.deepEqual(await collect(staged.open()), bytes, "a later retry can open another lease")
 assert.equal(staging.stats().activeStreams, 0)
 assert.equal(staging.stats().reservedBytes, bytes.length)
 await staged.cleanup()
 await staged.cleanup()
 assert.equal(fs.existsSync(staged.path), false)
 assert.equal(staging.stats().files, 0)
 assert.equal(staging.stats().reservedBytes, 0)
})

test("a real validated upload remains available after request cleanup", async (t) => {
 const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "wa-stage-test-"))
 const filename = path.join(root, "upload.png")
 t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
 const bytes = await fs.promises.readFile(path.join(__dirname, "fixtures", "image.png"))
 await fs.promises.writeFile(filename, bytes)
 const staging = createMediaStaging()
 t.after(() => staging.shutdown())
 const staged = await staging.stage({ kind: "image", maxBytes: 1000, file: { path: filename } })
 await fs.promises.unlink(filename)
 assert.equal(staged.mimetype, "image/png")
 assert.deepEqual(await collect(staged.open()), bytes)
 await staged.cleanup()
})

test("pending preparations reserve their maximum before opening a source", async (t) => {
 let allow
 let calls = 0
 const gate = new Promise((resolve) => { allow = resolve })
 const { staging } = fixture(t, { maxBytes: 100, prepareMediaSource: async () => {
  calls++
  await gate
  return { stream: Readable.from([Buffer.from("small")]), mimetype: "image/png", cleanup: async () => {} }
 } })
 const first = staging.stage(fileMedia(75))
 assert.equal(staging.stats().reservedBytes, 75)
 assert.equal(staging.stats().stagingFiles, 1)
 await assert.rejects(staging.stage(fileMedia(30)), { status: 429, code: "MEDIA_STAGING_FULL" })
 await waitFor(() => calls === 1)
 allow()
 const staged = await first
 assert.equal(calls, 1)
 assert.equal(staging.stats().reservedBytes, 5)
 await staged.cleanup()
})

test("URL staging budgets both the validated source spool and the queue copy", async (t) => {
 const { staging, prepared } = fixture(t, { maxBytes: 20 }, Buffer.from("small"))
 const media = { kind: "image", maxBytes: 11, url: "https://example.com/image.png" }
 await assert.rejects(staging.stage(media), { code: "MEDIA_STAGING_FULL" })
 assert.equal(prepared.length, 0)
 const staged = await staging.stage({ ...media, maxBytes: 10 })
 assert.equal(staging.stats().reservedBytes, 5)
 await staged.cleanup()
})

test("maximum file count is enforced independently of available bytes", async (t) => {
 const { staging } = fixture(t, { maxFiles: 2, maxBytes: 100 }, Buffer.from("x"))
 const first = await staging.stage(fileMedia(10))
 const second = await staging.stage(fileMedia(10))
 await assert.rejects(staging.stage(fileMedia(10)), { code: "MEDIA_STAGING_FULL" })
 assert.equal(staging.stats().stagedFiles, 2)
 await first.cleanup()
 const third = await staging.stage(fileMedia(10))
 await Promise.all([second.cleanup(), third.cleanup()])
 assert.equal(staging.stats().files, 0)
})

test("oversized or empty source streams fail before admission and release capacity", async (t) => {
 for (const [bytes, status] of [[Buffer.alloc(11), 413], [Buffer.alloc(0), 400]]) {
  const { staging, prepared } = fixture(t, { maxBytes: 100 }, bytes)
  await assert.rejects(staging.stage(fileMedia(10)), { status })
  assert.equal(prepared[0].cleaned, 1)
  assert.equal(staging.stats().reservedBytes, 0)
  assert.equal(staging.stats().files, 0)
 }
})

test("validation and upstream failures never leave an accepted file", async (t) => {
 const rejection = Object.assign(new Error("Unsupported image file format"), { status: 415, expose: true })
 const { staging } = fixture(t, { prepareMediaSource: async () => { throw rejection } })
 await assert.rejects(staging.stage(fileMedia()), (error) => error === rejection)
 assert.equal(staging.stats().files, 0)
 assert.equal(staging.stats().reservedBytes, 0)
})

test("unexpected source errors are sanitized and reservations are released", async (t) => {
 const { staging } = fixture(t, { prepareMediaSource: async () => { throw new Error("private /file/path secret") } })
 await assert.rejects(staging.stage(fileMedia()), (error) => {
  assert.equal(error.status, 503)
  assert.equal(error.code, "MEDIA_STAGING_UNAVAILABLE")
  assert.equal(error.message.includes("secret"), false)
  return true
 })
 assert.equal(staging.stats().reservedBytes, 0)
})

test("cancellation before staging does not allocate resources", async (t) => {
 const { staging, prepared } = fixture(t)
 const controller = new AbortController()
 controller.abort()
 await assert.rejects(staging.stage(fileMedia(), { signal: controller.signal }), { code: "MEDIA_STAGE_CANCELLED" })
 assert.equal(prepared.length, 0)
 assert.equal(staging.stats().files, 0)
})

test("cancellation during a copy closes source and destination before cleanup", async (t) => {
 const source = new PassThrough()
 let prepared = false
 let cleanups = 0
 const { staging } = fixture(t, { prepareMediaSource: async () => {
  prepared = true
  return { stream: source, mimetype: "image/png", cleanup: async () => { cleanups++; source.destroy() } }
 } })
 const controller = new AbortController()
 const operation = staging.stage(fileMedia(), { signal: controller.signal })
 await waitFor(() => prepared)
 source.write(Buffer.from("partial"))
 controller.abort()
 await assert.rejects(operation, { code: "MEDIA_STAGE_CANCELLED" })
 assert.equal(cleanups, 1)
 assert.equal(source.destroyed, true)
 assert.equal(staging.stats().reservedBytes, 0)
})

test("request cancellation after acceptance does not invalidate staged bytes", async (t) => {
 const { staging } = fixture(t)
 const controller = new AbortController()
 const staged = await staging.stage(fileMedia(), { signal: controller.signal })
 controller.abort()
 assert.equal((await collect(staged.open())).toString(), "validated media")
 await staged.cleanup()
})

test("one sweeper expires idle files and rejects later attempts to use them", async (t) => {
 const { staging } = fixture(t, { ttlMs: 35 })
 const staged = await staging.stage(fileMedia())
 await waitFor(() => staging.stats().files === 0)
 assert.equal(fs.existsSync(staged.path), false)
 assert.throws(() => staged.open(), { status: 410, code: "MEDIA_EXPIRED" })
 assert.equal(staging.stats().reservedBytes, 0)
})

test("TTL preserves an active lease, then removes its bytes after the stream closes", async (t) => {
 const { staging } = fixture(t, { ttlMs: 35 })
 const staged = await staging.stage(fileMedia())
 const stream = staged.open()
 await pause(60)
 assert.equal(fs.existsSync(staged.path), true)
 assert.equal(staging.stats().activeStreams, 1)
 assert.throws(() => staged.open(), { code: "MEDIA_EXPIRED" })
 assert.equal((await collect(stream)).toString(), "validated media")
 await waitFor(() => staging.stats().files === 0)
})

test("explicit cleanup closes outstanding leases before unlinking on Windows", async (t) => {
 const { staging } = fixture(t)
 const staged = await staging.stage(fileMedia())
 const stream = staged.open()
 await staged.cleanup()
 assert.equal(stream.closed, true)
 assert.equal(fs.existsSync(staged.path), false)
 assert.equal(staging.stats().activeStreams, 0)
 assert.equal(staging.stats().reservedBytes, 0)
})

test("failed removal retains capacity until cleanup succeeds", async (t) => {
 const { staging } = fixture(t)
 const staged = await staging.stage(fileMedia())
 const original = fs.promises.rm
 let fail = true
 const mocked = t.mock.method(fs.promises, "rm", async (directory, options) => {
  if (fail && directory === path.dirname(staged.path)) throw new Error("temporary filesystem failure")
  return original(directory, options)
 })
 await assert.rejects(staged.cleanup(), /temporary filesystem failure/)
 assert.equal(staging.stats().reservedBytes, staged.size)
 assert.equal(staging.stats().files, 1)
 fail = false
 await staged.cleanup()
 mocked.mock.restore()
 assert.equal(staging.stats().reservedBytes, 0)
 assert.equal(staging.stats().files, 0)
})

test("stop admission preserves accepted work and shutdown removes all files and streams", async (t) => {
 const { staging } = fixture(t)
 const staged = await staging.stage(fileMedia())
 const stream = staged.open()
 staging.stopAdmission()
 await assert.rejects(staging.stage(fileMedia()), { status: 503, code: "MEDIA_STAGING_CLOSED" })
 assert.equal(staging.stats().files, 1)
 const first = staging.shutdown()
 assert.equal(first, staging.shutdown())
 await first
 assert.equal(stream.closed, true)
 assert.equal(fs.existsSync(staged.path), false)
 assert.equal(staging.stats().files, 0)
 assert.equal(staging.stats().accepting, false)
})

test("shutdown aborts a pending preparation and reclaims its reservation", async (t) => {
 let entered = false
 const { staging } = fixture(t, { prepareMediaSource: async (_media, { signal }) => {
  entered = true
  return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
 } })
 const operation = staging.stage(fileMedia())
 const rejected = assert.rejects(operation, { code: "MEDIA_STAGE_CANCELLED" })
 await waitFor(() => entered)
 await staging.shutdown()
 await rejected
 assert.equal(staging.stats().files, 0)
 assert.equal(staging.stats().reservedBytes, 0)
})
