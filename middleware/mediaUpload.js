const Busboy = require("busboy")
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const { Transform } = require("node:stream")
const { pipeline } = require("node:stream/promises")

const MAX_FILE_BYTES = 100 * 1024 * 1024
const MAX_FIELDS = 16
const MAX_FIELD_BYTES = 8192
const MAX_TOTAL_FIELD_BYTES = 32 * 1024
const TEMP_PREFIX = "baileys-upload-"

function uploadError(status, message) {
 const error = new Error(message)
 error.status = status
 error.expose = true
 return error
}

function createMediaUpload({ maxFileBytes = MAX_FILE_BYTES } = {}) {
 if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes >= Number.MAX_SAFE_INTEGER) {
  throw new TypeError("maxFileBytes must be a positive safe integer")
 }

 return async function mediaUpload(req, res, next) {
  const contentType = req.headers["content-type"] || ""
  if (!/^multipart\/form-data(?:\s*;|\s*$)/i.test(contentType)) return next()

  const encoding = req.headers["content-encoding"]
  if (encoding && encoding.toLowerCase() !== "identity") {
   return next(uploadError(415, "Unsupported request encoding"))
  }

  let parser
  try {
   parser = Busboy({
    headers: req.headers,
    limits: {
     fileSize: maxFileBytes + 1,
     files: 1,
     fields: MAX_FIELDS,
     fieldSize: MAX_FIELD_BYTES,
     fieldNameSize: 100,
     parts: MAX_FIELDS + 1,
     headerPairs: 100
    }
   })
  } catch {
   return next(uploadError(400, "Invalid multipart request or missing boundary"))
  }

  let temporaryDirectory
  let failure
  let parsingFinished = false
  let clientAborted = false
  let rejectParsing
  let cleanupPromise
  let fieldBytes = 0
  let fileCount = 0
  const writes = []
  const fileStreams = new Set()
  const temporaryRoot = path.resolve(os.tmpdir())
  req.body = Object.create(null)

  const directoryPromise = fs.promises.mkdtemp(path.join(temporaryRoot, TEMP_PREFIX)).then((directory) => {
   temporaryDirectory = directory
   return directory
  })

  function fail(error, aborted = false) {
   if (aborted) clientAborted = true
   if (failure) return
   failure = error
   req.unpipe(parser)
   // Busboy can still be inside its file/field event when validation fails.
   // Destroying its active file synchronously corrupts the parser's current step.
   queueMicrotask(() => {
    parser.destroy()
    for (const stream of fileStreams) stream.destroy()
   })
   if (!req.destroyed) req.resume()
   if (rejectParsing) rejectParsing(error)
  }

  function cleanup() {
   if (!cleanupPromise) {
    cleanupPromise = (async () => {
     await directoryPromise
     await Promise.allSettled(writes)
     if (path.dirname(path.resolve(temporaryDirectory)) !== temporaryRoot || !path.basename(temporaryDirectory).startsWith(TEMP_PREFIX)) {
      throw new Error("Invalid temporary upload directory")
     }
     await fs.promises.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    })()
   }
   return cleanupPromise
  }

  function cleanupInBackground() {
   cleanup().catch((error) => {
    console.error("Temporary upload cleanup failed:", error.code || "unknown error")
   })
  }

  function onAborted() {
   fail(uploadError(400, "Upload was interrupted"), true)
   cleanupInBackground()
  }

  function onResponseClose() {
   if (!parsingFinished) fail(uploadError(400, "Upload was interrupted"), true)
   cleanupInBackground()
  }

  req.cleanupUpload = cleanup
  req.once("aborted", onAborted)
  res.once("finish", cleanupInBackground)
  res.once("close", onResponseClose)

  // Keep an error listener installed even while the temporary directory is created.
  parser.on("error", () => fail(uploadError(400, "Invalid or incomplete multipart request")))

  try {
   await directoryPromise
   if (req.aborted || req.destroyed || res.destroyed) {
    fail(uploadError(400, "Upload was interrupted"), true)
   }
   if (failure) throw failure

   await new Promise((resolve, reject) => {
    rejectParsing = reject

    parser.on("field", (name, value, info) => {
     if (failure) return
     if (info.nameTruncated || info.valueTruncated) {
      return fail(uploadError(413, "Multipart field is too large"))
     }
     fieldBytes += Buffer.byteLength(name) + Buffer.byteLength(value)
     if (fieldBytes > MAX_TOTAL_FIELD_BYTES) {
      return fail(uploadError(413, "Multipart fields are too large"))
     }
     if (!name || Buffer.byteLength(name) > 100) {
      return fail(uploadError(400, "Invalid multipart field name"))
     }
     if (Object.hasOwn(req.body, name)) {
      return fail(uploadError(400, `Duplicate multipart field: ${name}`))
     }
     req.body[name] = value
    })

    parser.on("file", (name, stream, info) => {
     fileStreams.add(stream)
     stream.once("close", () => fileStreams.delete(stream))
     if (failure) {
      stream.resume()
      return
     }
     if (name !== "file") {
      stream.resume()
      return fail(uploadError(400, 'The upload must use the "file" field'))
     }
     if (++fileCount !== 1) {
      stream.resume()
      return fail(uploadError(400, "Only one file can be uploaded"))
     }

     const file = {
      path: path.join(temporaryDirectory, "media"),
      originalname: path.basename(info.filename || "upload"),
      mimetype: info.mimeType,
      size: 0
     }
     req.file = file
     const counter = new Transform({
      transform(chunk, encoding, callback) {
       file.size += chunk.length
       if (file.size > maxFileBytes) {
        return callback(uploadError(413, `File exceeds the ${Math.floor(maxFileBytes / 1024 / 1024)} MiB upload limit`))
       }
       callback(null, chunk)
      }
     })
     stream.once("limit", () => fail(uploadError(413, "Uploaded file is too large")))
     const writing = pipeline(stream, counter, fs.createWriteStream(file.path, { flags: "wx", mode: 0o600 }))
     // Attach the rejection handler immediately: parser close can precede disk flush.
     writing.catch((error) => {
      if (failure) return
      fail(error.expose ? error : new Error("Unable to save uploaded file"))
     })
     writes.push(writing)
    })

    parser.once("filesLimit", () => fail(uploadError(400, "Only one file can be uploaded")))
    parser.once("fieldsLimit", () => fail(uploadError(413, "Too many multipart fields")))
    parser.once("partsLimit", () => fail(uploadError(413, "Too many multipart parts")))
    parser.once("close", () => {
     if (failure) reject(failure)
     else resolve()
    })
    req.pipe(parser)
   })
   await Promise.all(writes)
   if (failure) throw failure
   if (fileCount !== 1 || !req.file) throw uploadError(400, 'Multipart requests require one "file" upload')
   if (!req.file.size) throw uploadError(400, "Uploaded file is empty")
   parsingFinished = true
   req.removeListener("aborted", onAborted)
   return next()
  } catch (error) {
   fail(error)
   await cleanup()
   req.removeListener("aborted", onAborted)
   if (!clientAborted && !req.aborted && !res.destroyed) return next(error)
  }
 }
}

module.exports = createMediaUpload()
module.exports.createMediaUpload = createMediaUpload
