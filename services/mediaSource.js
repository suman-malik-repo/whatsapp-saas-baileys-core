const dns = require("node:dns")
const fs = require("node:fs")
const http = require("node:http")
const https = require("node:https")
const net = require("node:net")
const { Transform, pipeline } = require("node:stream")

const HEADER_TIMEOUT_MS = 10_000
const DOWNLOAD_TIMEOUT_MS = 60_000
const MAX_REDIRECTS = 3
let fileTypeModule

function mediaError(status, message) {
 const error = new Error(message)
 error.status = status
 error.expose = true
 return error
}

// Conservative public-unicast policy. Transition mechanisms are excluded because
// they can embed a second, otherwise blocked address.
function isPublicIp(address) {
 const family = net.isIP(address)
 if (family === 4) {
  const [a, b, c] = address.split(".").map(Number)
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
   (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
   (a === 172 && b >= 16 && b <= 31) ||
   (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
   (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
   (a === 203 && b === 0 && c === 113))
 }
 if (family !== 6 || address.includes("%")) return false
 const parts = address.toLowerCase().split(":")
 const first = parseInt(parts[0] || "0", 16)
 const second = parseInt(parts[1] || "0", 16)
 return first >= 0x2000 && first <= 0x3fff &&
  !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) &&
  first !== 0x2002 && !(first === 0x3fff && second < 0x1000)
}

function normalizeMime(value) {
 const base = String(value || "").split(";", 1)[0].trim().toLowerCase()
 const aliases = { "image/jpg": "image/jpeg", "audio/mp3": "audio/mpeg",
  "audio/x-wav": "audio/wav", "audio/wave": "audio/wav",
  "audio/x-m4a": "audio/mp4", "audio/opus": "audio/ogg" }
 return aliases[base] || base
}

function validateMime(media, detected, prefix, responseMime) {
 const actual = detected?.mime
 const normalized = normalizeMime(actual)
 const hint = normalizeMime(media.mimetype)
 if (media.url && (normalizeMime(responseMime) === "text/html" ||
     /^\s*(?:\uFEFF)?\s*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(prefix.toString("utf8")))) {
  throw mediaError(415, "The media URL returned an HTML page instead of a file")
 }
 if (media.kind === "document") {
  return actual || media.mimetype || "application/octet-stream"
 }
 const formats = {
  image: ["image/jpeg", "image/png", "image/webp"],
  video: ["video/mp4"], sticker: ["image/webp"],
  audio: ["audio/mpeg", "audio/ogg", "audio/mp4", "audio/aac", "audio/wav"]
 }
 if (!formats[media.kind]?.includes(normalized)) {
  throw mediaError(415, `Unsupported ${media.kind} file format`)
 }
 if (media.mimetypeExplicit && hint && hint !== normalized) {
  throw mediaError(415, "mimetype does not match the uploaded or downloaded file")
 }
 if ((media.requestedType === "voice" || media.ptt === true) &&
     (normalized !== "audio/ogg" || !/codecs=opus/i.test(actual))) {
  throw mediaError(415, "Voice notes require an Ogg/Opus audio file")
 }
 return actual
}

async function prepareMediaSource(media, { signal } = {}) {
 if (!media || !Number.isSafeInteger(media.maxBytes) || media.maxBytes <= 0 ||
     Boolean(media.url) === Boolean(media.file)) {
  throw mediaError(400, "Provide one valid media source")
 }

 const resources = new Set()
 const timers = new Set()
 const abortController = new AbortController()
 let closed = false
 let finalStream
 let fileClosed
 let cleanupPromise
 const track = (resource) => {
  resources.add(resource)
  // Streams can fail before Baileys attaches its consumer. The original error
  // still propagates through the pipeline and is never left unhandled.
  resource.on("error", () => {})
  return resource
 }
 const cleanup = () => {
  if (cleanupPromise) return cleanupPromise
  closed = true
  for (const timer of timers) clearTimeout(timer)
  timers.clear()
  signal?.removeEventListener("abort", onExternalAbort)
  for (const resource of resources) resource.destroy()
  resources.clear()
  // In particular, wait for a Windows upload's file descriptor to close before
  // the multipart owner attempts to unlink its temporary file.
  cleanupPromise = Promise.resolve(fileClosed).then(() => {})
  return cleanupPromise
 }
 const abort = (error) => {
  if (closed || abortController.signal.aborted) return
  abortController.abort(error)
  for (const resource of resources) resource.destroy(error)
 }
 const onExternalAbort = () => abort(mediaError(400, "Media request was cancelled"))
 const deadline = (milliseconds, message) => {
  const timer = setTimeout(() => abort(mediaError(504, message)), milliseconds)
  timer.unref?.()
  timers.add(timer)
  return timer
 }
 const clearDeadline = (timer) => { clearTimeout(timer); timers.delete(timer) }
 const checkAborted = () => abortController.signal.throwIfAborted()
 const abortable = (promise) => {
  checkAborted()
  return new Promise((resolve, reject) => {
   const onAbort = () => reject(abortController.signal.reason)
   abortController.signal.addEventListener("abort", onAbort, { once: true })
   promise.then(resolve, reject).finally(() => {
    abortController.signal.removeEventListener("abort", onAbort)
   })
  })
 }
 signal?.addEventListener("abort", onExternalAbort, { once: true })
 if (signal?.aborted) onExternalAbort()
 deadline(DOWNLOAD_TIMEOUT_MS, "Media download timed out")

 async function openUrl(rawUrl, redirects = 0) {
  checkAborted()
  let url
  try { url = new URL(rawUrl) } catch { throw mediaError(400, "Media URL is invalid") }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      (url.port && url.port !== (url.protocol === "http:" ? "80" : "443"))) {
   throw mediaError(400, "Media URL must use HTTP or HTTPS on its standard port without credentials")
  }
  const headerTimer = deadline(HEADER_TIMEOUT_MS, "Media server did not respond in time")
  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  let addresses
  try {
   addresses = net.isIP(hostname)
    ? [{ address: hostname, family: net.isIP(hostname) }]
    : await abortable(dns.promises.lookup(hostname, { all: true, verbatim: true }))
  } catch (error) {
   clearDeadline(headerTimer)
   checkAborted()
   throw mediaError(502, "Unable to resolve the media server")
  }
  if (!addresses.length || addresses.some(({ address }) => !isPublicIp(address))) {
   clearDeadline(headerTimer)
   throw mediaError(400, "Media URL must resolve only to public internet addresses")
  }
  const pinned = addresses[0]
  let response
  try {
   response = await abortable(new Promise((resolve, reject) => {
    checkAborted()
    const transport = url.protocol === "https:" ? https : http
    const request = track(transport.request(url, {
     method: "GET", agent: false,
     headers: { Accept: "*/*", "Accept-Encoding": "identity", "User-Agent": "WhatsApp-Media/1.0" },
     // Keep the URL hostname for Host and TLS/SNI, but never re-resolve DNS when
     // connecting. Every redirect repeats the same validation and pinning.
     lookup(_host, options, callback) {
      if (options?.all) callback(null, [pinned])
      else callback(null, pinned.address, pinned.family)
     }
    }, (incoming) => resolve(track(incoming))))
    request.once("error", () => reject(mediaError(502, "Unable to download the media file")))
    request.end()
   }))
  } finally { clearDeadline(headerTimer) }
  checkAborted()
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
   const location = response.headers.location
   response.destroy()
   if (!location || redirects >= MAX_REDIRECTS) throw mediaError(502, "Media URL has too many or invalid redirects")
   let nextUrl
   try { nextUrl = new URL(location, url).href } catch { throw mediaError(502, "Media URL has an invalid redirect") }
   return openUrl(nextUrl, redirects + 1)
  }
  if (response.statusCode !== 200) throw mediaError(502, "Media server did not return a downloadable file")
  const encoding = String(response.headers["content-encoding"] || "identity").toLowerCase()
  if (encoding !== "identity") throw mediaError(415, "Compressed HTTP responses are not supported for media")
  const length = response.headers["content-length"]
  if (length !== undefined) {
   if (!/^\d+$/.test(String(length))) throw mediaError(502, "Media server returned an invalid file size")
   if (Number(length) > media.maxBytes) throw mediaError(413, "Media file exceeds the size limit")
   if (Number(length) === 0) throw mediaError(400, "Media file must not be empty")
  }
  return { source: response, responseMime: response.headers["content-type"] }
 }

 try {
  checkAborted()
  // Load the ESM detector before opening a flowing source, so a cold import
  // cannot leave a stream error waiting without its detection listener.
  fileTypeModule ||= import("file-type")
  const { fileTypeStream } = await abortable(fileTypeModule)
  let source, responseMime
  if (media.url) ({ source, responseMime } = await openUrl(media.url))
  else {
   let stats
   try { stats = await abortable(fs.promises.stat(media.file.path)) }
   catch { checkAborted(); throw mediaError(400, "Uploaded media file could not be read") }
   if (!stats.isFile() || !stats.size) throw mediaError(400, "Media file must not be empty")
   if (stats.size > media.maxBytes) throw mediaError(413, "Media file exceeds the size limit")
   source = track(fs.createReadStream(media.file.path, { highWaterMark: 64 * 1024 }))
   fileClosed = new Promise((resolve) => source.once("close", resolve))
  }
  let bytes = 0
  let prefix = Buffer.alloc(0)
  const limited = track(new Transform({
   transform(chunk, _encoding, callback) {
    bytes += chunk.length
    if (bytes > media.maxBytes) return callback(mediaError(413, "Media file exceeds the size limit"))
    if (prefix.length < 512) prefix = Buffer.concat([prefix, chunk.subarray(0, 512 - prefix.length)])
    callback(null, chunk)
   },
   flush(callback) { callback(bytes ? null : mediaError(400, "Media file must not be empty")) }
  }))
  if (source.errored) throw source.errored
  pipeline(source, limited, () => {})
  finalStream = track(await fileTypeStream(limited, { signal: abortController.signal, sampleSize: 4100 }))
  checkAborted()
  const mimetype = validateMime(media, finalStream.fileType, prefix, responseMime)
  finalStream.once("end", () => { void cleanup() })
  finalStream.once("close", () => { void cleanup() })
  return { stream: finalStream, mimetype, cleanup }
 } catch (error) {
  const reason = abortController.signal.aborted ? abortController.signal.reason : error
  await cleanup()
  if (reason?.expose && Number.isInteger(reason.status)) throw reason
  throw mediaError(502, "Unable to read the media file")
 }
}

module.exports = { prepareMediaSource, isPublicIp }
