const fs = require("node:fs/promises")
const sharp = require("sharp")

const MAX_IMAGE_PIXELS = 40_000_000
const MAX_IMAGE_DIMENSION = 16_384
const MAX_IMAGE_FRAMES = 100
const MAX_STICKER_DIMENSION = 512
let metadataModule
const readCaches = new WeakMap()

function invalid(message = "The media file is invalid, incomplete or unsupported") {
 const error = new Error(message)
 error.status = 415
 error.expose = true
 throw error
}

function check(signal) { signal?.throwIfAborted() }
function positive(value) { return Number.isFinite(value) && value > 0 }

async function read(handle, offset, length, signal) {
 check(signal)
 const cache = readCaches.get(handle)
 if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || offset + length > cache.size) invalid()
 if (!length) return Buffer.alloc(0)
 if (!cache.buffer || offset < cache.offset || offset + length > cache.offset + cache.buffer.length) {
  // Frame headers are tiny; one small sequential window avoids a filesystem
  // operation per MP3/AAC frame without buffering an entire audio/video file.
  const buffer = Buffer.alloc(Math.min(Math.max(64 * 1024, length), cache.size - offset))
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
  if (bytesRead < length) invalid()
  cache.offset = offset
  cache.buffer = buffer.subarray(0, bytesRead)
 }
 return Buffer.from(cache.buffer.subarray(offset - cache.offset, offset - cache.offset + length))
}

// Inspect lengths without allocating according to untrusted container metadata.
async function riff(handle, size, expected, signal) {
 const header = await read(handle, 0, 12, signal)
 if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== expected ||
     header.readUInt32LE(4) + 8 !== size) invalid()
 let offset = 12
 let chunks = 0
 let data = false
 let format = false
 while (offset < size) {
  if (++chunks > 100_000 || size - offset < 8) invalid()
  const chunk = await read(handle, offset, 8, signal)
  const length = chunk.readUInt32LE(4)
  const end = offset + 8 + length + (length % 2)
  if (end > size) invalid()
  const name = chunk.toString("ascii", 0, 4)
  if (name === "data" && length > 0) data = true
  if (name === "fmt " && length >= 16) format = true
  offset = end
 }
 if (expected === "WAVE" && (!format || !data)) invalid()
}

async function png(handle, size, signal) {
 let offset = 8
 let chunks = 0
 let hasData = false
 while (offset < size) {
  if (++chunks > 100_000 || size - offset < 12) invalid()
  const header = await read(handle, offset, 8, signal)
  const length = header.readUInt32BE(0)
  const name = header.toString("ascii", 4, 8)
  if (offset + length + 12 > size || (chunks === 1 && (name !== "IHDR" || length !== 13))) invalid()
  if (name === "IDAT" && length > 0) hasData = true
  offset += length + 12
  if (name === "IEND") {
   if (length !== 0 || !hasData || offset !== size) invalid()
   return
  }
 }
 invalid()
}

async function validateImage(media, mime, handle, size, signal) {
 if (size > (media.kind === "sticker" ? 1024 * 1024 : 10 * 1024 * 1024)) invalid("Image file exceeds the validation size limit")
 if (!["image/png", "image/jpeg", "image/webp"].includes(mime)) invalid()
 if (mime === "image/png") await png(handle, size, signal)
 if (mime === "image/webp") await riff(handle, size, "WEBP", signal)
 if (mime === "image/jpeg") {
  const tail = await read(handle, size - 2, 2, signal)
  if (tail[0] !== 0xff || tail[1] !== 0xd9) invalid()
 }
 // libvips caches file-backed decoders, retaining Windows file handles after
 // Sharp.destroy(). The small, size-bounded encoded image buffer avoids those
 // handles and lets the upload owner remove its file immediately.
 const encoded = await handle.readFile({ signal })
 const decoder = sharp(encoded, {
  animated: true, failOn: "warning", limitInputPixels: MAX_IMAGE_PIXELS, sequentialRead: true
 }).timeout({ seconds: 10 })
 const onAbort = () => decoder.destroy()
 signal?.addEventListener("abort", onAbort, { once: true })
 try {
  check(signal)
  const metadata = await decoder.metadata()
  const width = metadata.width
  const height = metadata.pageHeight || metadata.height
  const frames = metadata.pages || 1
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION ||
      !Number.isSafeInteger(frames) || frames < 1 || frames > MAX_IMAGE_FRAMES ||
      width * height * frames > MAX_IMAGE_PIXELS) {
   invalid("Images must fit within 16384 pixels per side, 100 frames and 40 million total pixels")
  }
  if (media.kind === "sticker" && (width > MAX_STICKER_DIMENSION || height > MAX_STICKER_DIMENSION)) {
   invalid("Stickers must be at most 512 pixels wide and high")
  }
  const animated = frames > 1
  if (media.kind === "sticker" && media.isAnimated !== undefined && media.isAnimated !== animated) {
   invalid("isAnimated does not match the sticker file")
  }
  const formats = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp" }
  if (formats[mime] !== metadata.format || media.kind === "sticker" && metadata.format !== "webp") invalid()
  // Metadata alone accepts truncated images. Force a strict, bounded decode of
  // all pixels/frames before handing the original file to WhatsApp.
  await decoder.stats()
  check(signal)
  return { width, height, frames, animated }
 } finally {
  signal?.removeEventListener("abort", onAbort)
  decoder.destroy()
 }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
 let value = index << 24
 for (let bit = 0; bit < 8; bit++) value = (value << 1) ^ (value < 0 ? 0x04c11db7 : 0)
 return value >>> 0
})

async function ogg(handle, size, signal) {
 let offset = 0
 let pages = 0
 const streams = new Map()
 while (offset < size) {
  if (++pages > 100_000) invalid()
  const header = await read(handle, offset, 27, signal)
  if (header.toString("ascii", 0, 4) !== "OggS" || header[4] !== 0 || header[5] > 7) invalid()
  const segments = await read(handle, offset + 27, header[26], signal)
  const payloadLength = segments.reduce((sum, value) => sum + value, 0)
  const pageLength = 27 + segments.length + payloadLength
  if (offset + pageLength > size) invalid()
  const page = await read(handle, offset, pageLength, signal)
  const expectedCrc = page.readUInt32LE(22)
  page.fill(0, 22, 26)
  let crc = 0
  for (const byte of page) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 255]) >>> 0
  if (crc !== expectedCrc) invalid()
  const serial = header.readUInt32LE(14)
  const sequence = header.readUInt32LE(18)
  const previous = streams.get(serial)
  if (previous ? previous.closed || sequence !== previous.sequence + 1 || (header[5] & 2) : !(header[5] & 2) || sequence !== 0) invalid()
  streams.set(serial, { sequence, closed: Boolean(header[5] & 4) })
  offset += pageLength
 }
 if (!pages || [...streams.values()].some((stream) => !stream.closed)) invalid()
}

async function mp4(handle, size, signal) {
 let boxes = 0
 let hasMoov = false
 let mediaBytes = 0
 let movieDuration
 const tracks = []
 const duration = (buffer) => {
  const version = buffer[0]
  if (version !== 0 && version !== 1) invalid()
  const timeOffset = version === 1 ? 20 : 12
  const required = version === 1 ? 32 : 20
  if (buffer.length < required) invalid()
  const timeScale = buffer.readUInt32BE(timeOffset)
  const ticks = version === 1 ? Number(buffer.readBigUInt64BE(timeOffset + 4)) : buffer.readUInt32BE(timeOffset + 4)
  return timeScale > 0 ? ticks / timeScale : undefined
 }
 async function scan(start, end, depth = 0, track) {
  if (depth > 8) invalid()
  let offset = start
  while (offset < end) {
   if (++boxes > 100_000 || end - offset < 8) invalid()
   const header = await read(handle, offset, Math.min(16, end - offset), signal)
   const name = header.toString("ascii", 4, 8)
   let length = header.readUInt32BE(0)
   let headerSize = 8
   if (length === 1) {
    if (header.length < 16) invalid()
    length = Number(header.readBigUInt64BE(8))
    headerSize = 16
   } else if (length === 0) length = end - offset
   if (!Number.isSafeInteger(length) || length < headerSize || offset + length > end) invalid()
   const payload = offset + headerSize
   const payloadSize = length - headerSize
   if (name === "mdat" && depth === 0) mediaBytes += payloadSize
   if (name === "moov" && depth === 0) hasMoov = true
   if (name === "trak") {
    const current = {}
    tracks.push(current)
    await scan(payload, offset + length, depth + 1, current)
   } else if (["moov", "mdia", "minf", "stbl"].includes(name)) {
    await scan(payload, offset + length, depth + 1, track)
   } else if (name === "mvhd" || name === "mdhd") {
    const value = duration(await read(handle, payload, Math.min(payloadSize, 32), signal))
    if (name === "mvhd") movieDuration = value
    else if (track) track.duration = value
   } else if (name === "hdlr" && track) {
    if (payloadSize < 12) invalid()
    track.handler = (await read(handle, payload + 8, 4, signal)).toString("ascii")
   } else if (name === "stsd" && track) {
    if (payloadSize < 8) invalid()
    track.descriptions = (await read(handle, payload + 4, 4, signal)).readUInt32BE(0)
   }
   offset += length
  }
 }
 await scan(0, size)
 if (!hasMoov || mediaBytes < 1 || !tracks.length) invalid()
 return { tracks: tracks.filter((track) => track.descriptions > 0), duration: movieDuration }
}

async function id3Start(handle, size, signal) {
 if (size < 10) return 0
 const header = await read(handle, 0, 10, signal)
 if (header.toString("ascii", 0, 3) !== "ID3") return 0
 if (header.subarray(6).some((byte) => byte & 0x80)) invalid()
 const length = header[6] * 2097152 + header[7] * 16384 + header[8] * 128 + header[9]
 const offset = length + 10 + (header[3] === 4 && header[5] & 0x10 ? 10 : 0)
 if (offset >= size) invalid()
 return offset
}

async function adts(handle, size, signal) {
 let offset = await id3Start(handle, size, signal)
 let samples = 0
 let sampleRate
 let channels
 const frequencies = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]
 while (offset < size) {
  const header = await read(handle, offset, 7, signal)
  if (header[0] !== 255 || (header[1] & 0xf6) !== 0xf0) invalid()
  const rate = frequencies[(header[2] >>> 2) & 15]
  const channel = ((header[2] & 1) << 2) | (header[3] >>> 6)
  const length = ((header[3] & 3) << 11) | (header[4] << 3) | (header[5] >>> 5)
  const headerSize = header[1] & 1 ? 7 : 9
  if (!rate || !channel || length <= headerSize || offset + length > size ||
      sampleRate && (rate !== sampleRate || channel !== channels)) invalid()
  sampleRate = rate
  channels = channel
  samples += 1024 * ((header[6] & 3) + 1)
  offset += length
 }
 if (!samples) invalid()
 return { sampleRate, numberOfChannels: channels, duration: samples / sampleRate, codec: "AAC" }
}

async function mpeg(handle, size, signal) {
 let offset = await id3Start(handle, size, signal)
 let end = size
 if (end - offset >= 128 && (await read(handle, end - 128, 3, signal)).toString("ascii") === "TAG") end -= 128
 if (end - offset >= 32) {
  const footer = await read(handle, end - 32, 32, signal)
  if (footer.toString("ascii", 0, 8) === "APETAGEX") {
   const length = footer.readUInt32LE(12)
   if (length < 32 || length > end - offset) invalid()
   end -= length
   // APEv2's optional header is not included in its declared tag size.
   if (end - offset >= 32 && (await read(handle, end - 32, 8, signal)).toString("ascii") === "APETAGEX") end -= 32
  }
 }
 const mpeg1 = {
  3: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
 }
 let frames = 0
 while (offset < end) {
  if (end - offset < 4) invalid()
  const header = await read(handle, offset, 4, signal)
  if (header[0] !== 255 || (header[1] & 0xe0) !== 0xe0) invalid()
  const version = (header[1] >>> 3) & 3
  const layer = (header[1] >>> 1) & 3
  const index = header[2] >>> 4
  const sampleIndex = (header[2] >>> 2) & 3
  if (version === 1 || !layer || index === 0 || index === 15 || sampleIndex === 3) invalid()
  const lowBitrates = layer === 3 ? [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256] :
   [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
  const bitrate = (version === 3 ? mpeg1[layer][index] : lowBitrates[index]) * 1000
  const rate = [44100, 48000, 32000][sampleIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4)
  const padding = (header[2] >>> 1) & 1
  const length = layer === 3 ? (Math.floor(12 * bitrate / rate) + padding) * 4 :
   Math.floor((layer === 1 && version !== 3 ? 72 : 144) * bitrate / rate) + padding
  if (length <= 4 || offset + length > end) invalid()
  offset += length
  frames++
 }
 if (!frames) invalid()
}

async function validateAudioVideo(filePath, media, mime, handle, size, signal) {
 let container
 let audio
 if (["video/mp4", "audio/mp4", "audio/x-m4a"].includes(mime)) container = await mp4(handle, size, signal)
 else if (mime === "audio/ogg") await ogg(handle, size, signal)
 else if (mime === "audio/wav") await riff(handle, size, "WAVE", signal)
 else if (mime === "audio/aac") audio = await adts(handle, size, signal)
 else if (mime === "audio/mpeg") await mpeg(handle, size, signal)
 else invalid()
 check(signal)
 metadataModule ||= import("music-metadata")
 const { parseFile } = await metadataModule
 const metadata = await parseFile(filePath, { duration: true, skipCovers: true })
 check(signal)
 // ADTS does not reliably expose timing for very short files in the metadata
 // parser. Its complete frame walk above supplies validated timing instead.
 const format = audio || metadata.format
 const warnings = metadata.quality?.warnings || []
 if (warnings.some(({ message }) => /corrupt|end-of-stream|exceeding file length|invalid frame|unexpected end/i.test(message))) invalid()
 if (media.kind === "video") {
  const track = container?.tracks.find((entry) => entry.handler === "vide")
  const duration = positive(track?.duration) ? track.duration : container?.duration
  if (!track || !positive(duration) || duration > 86400) invalid("Video files must contain a valid video track and a duration of at most 24 hours")
  return { duration, hasVideo: true }
 }
 if (container && !container.tracks.some((entry) => entry.handler === "soun")) invalid()
 if (!positive(format.sampleRate) || format.sampleRate > 384000 || !Number.isSafeInteger(format.numberOfChannels) ||
     format.numberOfChannels < 1 || format.numberOfChannels > 32 || !positive(format.duration) || format.duration > 86400 ||
     !format.codec || metadata.format.hasVideo === true) {
  invalid("Audio files must contain a valid audio track and a duration of at most 24 hours")
 }
 if ((media.requestedType === "voice" || media.ptt === true) &&
     (mime !== "audio/ogg" || !/^opus$/i.test(format.codec))) {
  invalid("Voice notes require an Ogg/Opus audio file")
 }
 return { duration: format.duration, sampleRate: format.sampleRate, channels: format.numberOfChannels, codec: format.codec }
}

async function validateMediaFile(filePath, media, detectedMime, { signal } = {}) {
 check(signal)
 if (media.kind === "document") return {}
 const mime = String(detectedMime || "").split(";", 1)[0].toLowerCase().trim()
 let handle
 try {
  handle = await fs.open(filePath, "r")
  const { size } = await handle.stat()
  readCaches.set(handle, { size })
  if (!size) invalid()
  if (media.kind === "image" || media.kind === "sticker") {
   return await validateImage(media, mime, handle, size, signal)
  }
  return await validateAudioVideo(filePath, media, mime, handle, size, signal)
 } catch (error) {
  check(signal)
  if (error.expose === true && error.status === 415) throw error
  invalid()
 } finally {
  if (handle) readCaches.delete(handle)
  await handle?.close()
 }
}

module.exports = { validateMediaFile }
