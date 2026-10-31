const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const sharp = require("sharp")
const { validateMediaFile } = require("../services/mediaValidation")

const fixture = (name) => path.join(__dirname, "fixtures", name)
const invalid = (error) => error.status === 415 && error.expose === true &&
 typeof error.message === "string" && !error.message.includes(os.tmpdir())

async function temporary(t, bytes) {
 const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wa-validation-test-"))
 t.after(() => fs.rm(directory, { recursive: true, force: true }))
 const filename = path.join(directory, "media")
 await fs.writeFile(filename, bytes)
 return filename
}

test("real PNG, JPEG and WebP images are fully decoded", async () => {
 for (const [name, mime] of [["image.png", "image/png"], ["image.jpg", "image/jpeg"], ["image.webp", "image/webp"]]) {
  assert.deepEqual(await validateMediaFile(fixture(name), { kind: "image" }, mime),
   { width: 8, height: 8, frames: 1, animated: false })
 }
})

test("truncated, signature-only and corrupt images are rejected", async (t) => {
 const png = await fs.readFile(fixture("image.png"))
 const jpeg = await fs.readFile(fixture("image.jpg"))
 const webp = await fs.readFile(fixture("image.webp"))
 const corrupt = Buffer.from(png)
 corrupt[corrupt.length - 20] ^= 255
 const cases = [
  [Buffer.from("ffd8ffff", "hex"), "image/jpeg"],
  [png.subarray(0, png.length - 12), "image/png"],
  [jpeg.subarray(0, jpeg.length - 2), "image/jpeg"],
  [webp.subarray(0, webp.length - 1), "image/webp"],
  [corrupt, "image/png"],
  [Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(24)]), "image/webp"]
 ]
 for (const [bytes, mime] of cases) {
  await assert.rejects(validateMediaFile(await temporary(t, bytes), { kind: "image" }, mime), invalid)
 }
})

test("sticker animation metadata must match the actual WebP frames", async () => {
 const animated = await validateMediaFile(fixture("animated.webp"), { kind: "sticker", isAnimated: true }, "image/webp")
 assert.equal(animated.frames, 2)
 assert.equal(animated.animated, true)
 await validateMediaFile(fixture("image.webp"), { kind: "sticker", isAnimated: false }, "image/webp")
 await assert.rejects(validateMediaFile(fixture("image.webp"), { kind: "sticker", isAnimated: true }, "image/webp"), invalid)
 await assert.rejects(validateMediaFile(fixture("animated.webp"), { kind: "sticker", isAnimated: false }, "image/webp"), invalid)
})

test("sticker dimensions are bounded independently of encoded byte size", async (t) => {
 const bytes = await sharp({ create: { width: 513, height: 1, channels: 3, background: "blue" } }).webp().toBuffer()
 await assert.rejects(validateMediaFile(await temporary(t, bytes), { kind: "sticker" }, "image/webp"),
  { status: 415, message: "Stickers must be at most 512 pixels wide and high" })
 const accepted = await sharp({ create: { width: 512, height: 1, channels: 3, background: "blue" } }).webp().toBuffer()
 assert.equal((await validateMediaFile(await temporary(t, accepted), { kind: "sticker" }, "image/webp")).width, 512)
})

test("image dimension and animation frame limits are enforced before decoding", async (t) => {
 const wide = await sharp({ create: { width: 16385, height: 1, channels: 3, background: "blue" } }).png().toBuffer()
 await assert.rejects(validateMediaFile(await temporary(t, wide), { kind: "image" }, "image/png"), invalid)
 const pixels = Buffer.alloc(8 * 8 * 101 * 3)
 for (let frame = 0; frame < 101; frame++) pixels.fill(frame, frame * 8 * 8 * 3, (frame + 1) * 8 * 8 * 3)
 const animation = await sharp(pixels, { raw: { width: 8, height: 808, channels: 3, pageHeight: 8 } })
  .webp({ lossless: true, delay: 100 }).toBuffer()
 assert.equal((await sharp(animation, { animated: true }).metadata()).pages, 101)
 await assert.rejects(validateMediaFile(await temporary(t, animation), { kind: "image" }, "image/webp"), invalid)
})

test("silent MP4 video has a video track and valid duration", async () => {
 assert.deepEqual(await validateMediaFile(fixture("video.mp4"), { kind: "video" }, "video/mp4"),
  { duration: 0.4, hasVideo: true })
})

test("MP4 requires actual media data and the requested kind of track", async (t) => {
 const fake = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(12)])
 await assert.rejects(validateMediaFile(await temporary(t, fake), { kind: "video" }, "video/mp4"), invalid)
 await assert.rejects(validateMediaFile(fixture("audio.m4a"), { kind: "video" }, "video/mp4"), invalid)
 await assert.rejects(validateMediaFile(fixture("video.mp4"), { kind: "audio" }, "audio/mp4"), invalid)
 const video = await fs.readFile(fixture("video.mp4"))
 await assert.rejects(validateMediaFile(await temporary(t, video.subarray(0, video.length - 1)), { kind: "video" }, "video/mp4"), invalid)
 const overrun = Buffer.from(video)
 overrun.writeUInt32BE(video.length + 1, 0)
 await assert.rejects(validateMediaFile(await temporary(t, overrun), { kind: "video" }, "video/mp4"), invalid)
})

test("real MP3, M4A, WAV, ADTS AAC and Ogg files expose valid audio metadata", async () => {
 const cases = [["audio.mp3", "audio/mpeg"], ["audio.m4a", "audio/mp4"], ["audio.wav", "audio/wav"],
  ["audio.aac", "audio/aac"], ["audio-vorbis.ogg", "audio/ogg"], ["voice.ogg", "audio/ogg; codecs=opus"]]
 for (const [name, mime] of cases) {
  const metadata = await validateMediaFile(fixture(name), { kind: "audio" }, mime)
  assert.equal(metadata.sampleRate, 48000, name)
  assert.equal(metadata.channels, 1, name)
  assert.ok(metadata.duration > 0, name)
  assert.equal(typeof metadata.codec, "string", name)
 }
})

test("voice notes require actual Ogg/Opus audio", async (t) => {
 const metadata = await validateMediaFile(fixture("voice.ogg"), { kind: "audio", requestedType: "voice" }, "audio/ogg; codecs=opus")
 assert.equal(metadata.codec, "Opus")
 await validateMediaFile(fixture("voice.ogg"), { kind: "audio", ptt: true }, "audio/ogg; codecs=opus")
 await assert.rejects(validateMediaFile(fixture("audio-vorbis.ogg"), { kind: "audio", ptt: true }, "audio/ogg"), invalid)
 const fake = Buffer.alloc(80)
 fake.write("OggS")
 fake.write("OpusHead", 28)
 await assert.rejects(validateMediaFile(await temporary(t, fake), { kind: "audio", ptt: true }, "audio/ogg; codecs=opus"), invalid)
})

test("truncated audio containers and frames are rejected", async (t) => {
 for (const [name, mime] of [["voice.ogg", "audio/ogg"], ["audio.wav", "audio/wav"],
  ["audio.m4a", "audio/mp4"], ["audio.mp3", "audio/mpeg"], ["audio.aac", "audio/aac"]]) {
  const bytes = await fs.readFile(fixture(name))
  await assert.rejects(validateMediaFile(await temporary(t, bytes.subarray(0, bytes.length - 1)), { kind: "audio" }, mime), invalid)
 }
})

test("Ogg page checksums and closing pages are validated", async (t) => {
 const corrupted = Buffer.from(await fs.readFile(fixture("voice.ogg")))
 corrupted[corrupted.length - 1] ^= 255
 await assert.rejects(validateMediaFile(await temporary(t, corrupted), { kind: "audio" }, "audio/ogg"), invalid)
})

test("forged audio duration and excessive sampling rates are rejected", async (t) => {
 const forged = Buffer.from(await fs.readFile(fixture("voice.ogg")))
 let offset = 0
 let lastPage = 0
 while (offset < forged.length) {
  lastPage = offset
  const segments = forged[offset + 26]
  const payload = forged.subarray(offset + 27, offset + 27 + segments).reduce((sum, value) => sum + value, 0)
  offset += 27 + segments + payload
 }
 const page = forged.subarray(lastPage)
 page.writeBigUInt64LE(10000000000000000n, 6)
 page.fill(0, 22, 26)
 let crc = 0
 for (const byte of page) {
  crc ^= byte << 24
  for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc < 0 ? 0x04c11db7 : 0)
 }
 page.writeUInt32LE(crc >>> 0, 22)
 await assert.rejects(validateMediaFile(await temporary(t, forged), { kind: "audio", ptt: true }, "audio/ogg; codecs=opus"), invalid)
 const wav = Buffer.from(await fs.readFile(fixture("audio.wav")))
 const formatOffset = wav.indexOf("fmt ") + 8
 wav.writeUInt32LE(400000, formatOffset + 4)
 await assert.rejects(validateMediaFile(await temporary(t, wav), { kind: "audio" }, "audio/wav"), invalid)
})

test("documents remain opaque attachments and validation respects cancellation", async (t) => {
 const text = await temporary(t, Buffer.from("an arbitrary plain-text document"))
 assert.deepEqual(await validateMediaFile(text, { kind: "document" }, "text/plain"), {})
 const controller = new AbortController()
 controller.abort()
 await assert.rejects(validateMediaFile(fixture("image.png"), { kind: "image" }, "image/png", { signal: controller.signal }),
  { name: "AbortError" })
 await assert.rejects(validateMediaFile(path.join(os.tmpdir(), "nonexistent-validation-file"), { kind: "image" }, "image/png"), invalid)
})
