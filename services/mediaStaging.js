const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { Transform } = require("node:stream")
const { pipeline } = require("node:stream/promises")
const { prepareMediaSource: defaultPrepareMediaSource } = require("./mediaSource")

const TEMP_PREFIX = "baileys-stage-"

function stagingError(status, code, message) {
 const error = new Error(message)
 error.status = status
 error.code = code
 error.expose = true
 return error
}

function createMediaStaging({ maxBytes = 256 * 1024 * 1024, maxFiles = 32,
 ttlMs = 300_000, prepareMediaSource = defaultPrepareMediaSource } = {}) {
 for (const [name, value] of Object.entries({ maxBytes, maxFiles, ttlMs })) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`)
 }
 if (typeof prepareMediaSource !== "function") throw new TypeError("prepareMediaSource must be a function")

 const temporaryRoot = path.resolve(os.tmpdir())
 const records = new Set()
 let reservedBytes = 0
 let accepting = true
 let shutdownPromise
 let sweeping = false

 const cancelled = () => stagingError(400, "MEDIA_STAGE_CANCELLED", "Media staging was cancelled")
 const expired = () => stagingError(410, "MEDIA_EXPIRED", "Staged media has expired; submit a new request")
 const backgroundCleanup = (record) => cleanupRecord(record).catch(() => {
  // Retain the reservation until removal succeeds. No filenames or message data
  // belong in operational logs.
  console.error("Staged media cleanup failed")
 })

 async function cleanupRecord(record) {
  if (record.removed) return
  record.cleanupRequested = true
  if (record.cleanupPromise) return record.cleanupPromise
  record.cleanupPromise = (async () => {
   for (const stream of record.streams) stream.destroy()
   await Promise.allSettled([...record.streamClosures])
   if (record.source) await record.source.cleanup()
   if (record.directory) {
    const directory = path.resolve(record.directory)
    if (path.dirname(directory) !== temporaryRoot || !path.basename(directory).startsWith(TEMP_PREFIX)) {
     throw new Error("Invalid staged media directory")
    }
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
   }
   reservedBytes -= record.reservation
   record.reservation = 0
   record.removed = true
   records.delete(record)
  })()
  try { await record.cleanupPromise }
  finally { record.cleanupPromise = null }
 }

 const sweeper = setInterval(() => {
  if (sweeping) return
  sweeping = true
  const now = Date.now()
  Promise.allSettled([...records].filter((record) => !record.pending &&
   (record.cleanupRequested || (record.expiresAt <= now && !record.streams.size)))
   .map(backgroundCleanup)).finally(() => { sweeping = false })
 }, Math.max(10, Math.min(1000, Math.floor(ttlMs / 4))))
 sweeper.unref?.()

 async function stage(media, { signal } = {}) {
  if (!accepting) throw stagingError(503, "MEDIA_STAGING_CLOSED", "The worker is not accepting media jobs")
  if (!media || !Number.isSafeInteger(media.maxBytes) || media.maxBytes <= 0 ||
      Boolean(media.url) === Boolean(media.file)) {
   throw stagingError(400, "MEDIA_STAGING_INVALID", "Provide one valid media source")
  }
  if (signal?.aborted) throw cancelled()
  // Remote validation first spools a complete source, then this service copies
  // it into queue ownership. Account for both files during that overlap.
  const reservation = media.maxBytes * (media.url ? 2 : 1)
  if (!Number.isSafeInteger(reservation) || records.size >= maxFiles || reservation > maxBytes - reservedBytes) {
   throw stagingError(429, "MEDIA_STAGING_FULL", "Media staging capacity is full; retry later")
  }
  const controller = new AbortController()
  const onAbort = () => controller.abort(cancelled())
  signal?.addEventListener("abort", onAbort, { once: true })
  const record = { reservation, directory: null, source: null, size: 0, expiresAt: Infinity,
   pending: true, streams: new Set(), streamClosures: new Set(), cleanupRequested: false,
   cleanupPromise: null, removed: false, controller, operation: null }
  reservedBytes += reservation
  records.add(record)

  const operation = (async () => {
   try {
    record.directory = await fs.promises.mkdtemp(path.join(temporaryRoot, TEMP_PREFIX))
    controller.signal.throwIfAborted()
    record.source = await prepareMediaSource(media, { signal: controller.signal })
    controller.signal.throwIfAborted()
    record.mimetype = record.source.mimetype
    record.metadata = record.source.metadata
    const filename = path.join(record.directory, "media")
    const destination = fs.createWriteStream(filename, { flags: "wx", mode: 0o600 })
    const limited = new Transform({
     transform(chunk, _encoding, callback) {
      record.size += chunk.length
      if (record.size > media.maxBytes) return callback(stagingError(413, "MEDIA_TOO_LARGE", "Media file exceeds the size limit"))
      callback(null, chunk)
     },
     flush(callback) {
      callback(record.size ? null : stagingError(400, "MEDIA_EMPTY", "Media file must not be empty"))
     }
    })
    await pipeline(record.source.stream, limited, destination, { signal: controller.signal })
    await record.source.cleanup()
    record.source = null
    controller.signal.throwIfAborted()
    reservedBytes -= record.reservation - record.size
    record.reservation = record.size
    record.expiresAt = Date.now() + ttlMs
    const prepared = {
     path: filename,
     size: record.size,
     mimetype: record.mimetype,
     metadata: record.metadata,
     expiresAt: record.expiresAt,
     open() {
      if (record.removed || record.cleanupRequested || Date.now() >= record.expiresAt) {
       if (!record.streams.size && !record.pending) backgroundCleanup(record)
       throw expired()
      }
      const stream = fs.createReadStream(filename, { highWaterMark: 64 * 1024 })
      const closure = new Promise((resolve) => stream.once("close", resolve))
      record.streamClosures.add(closure)
      record.streams.add(stream)
      stream.on("error", () => {})
      stream.once("close", () => {
       record.streams.delete(stream)
       record.streamClosures.delete(closure)
       if (!record.streams.size && Date.now() >= record.expiresAt) backgroundCleanup(record)
      })
      return stream
     },
     cleanup: () => cleanupRecord(record)
    }
    return Object.freeze(prepared)
   } catch (error) {
    const reason = controller.signal.aborted ? controller.signal.reason : error
    try { await cleanupRecord(record) } catch { console.error("Staged media cleanup failed") }
    if (reason?.expose && Number.isInteger(reason.status)) throw reason
    throw stagingError(503, "MEDIA_STAGING_UNAVAILABLE", "Unable to stage media for this job")
   } finally {
    record.pending = false
    signal?.removeEventListener("abort", onAbort)
   }
  })()
  record.operation = operation
  return operation
 }

 function stats() {
  const entries = [...records]
  return {
   accepting, maxBytes, maxFiles, ttlMs, reservedBytes,
   files: entries.length,
   stagingFiles: entries.filter((record) => record.pending).length,
   stagedFiles: entries.filter((record) => !record.pending).length,
   storedBytes: entries.reduce((sum, record) => sum + record.size, 0),
   activeStreams: entries.reduce((sum, record) => sum + record.streams.size, 0)
  }
 }

 function stopAdmission() { accepting = false }

 function shutdown() {
  if (shutdownPromise) return shutdownPromise
  stopAdmission()
  clearInterval(sweeper)
  shutdownPromise = (async () => {
   for (const record of records) if (record.pending) record.controller.abort(cancelled())
   await Promise.allSettled([...records].filter((record) => record.pending).map((record) => record.operation))
   const results = await Promise.allSettled([...records].map(cleanupRecord))
   if (results.some((result) => result.status === "rejected")) throw new Error("Unable to remove all staged media")
  })()
  return shutdownPromise
 }

 return { stage, stats, stopAdmission, shutdown }
}

module.exports = { createMediaStaging }
