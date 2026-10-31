const { buildMessagePayload } = require("../utils/messagePayload")
const { prepareMediaSource: defaultPrepareMediaSource } = require("../services/mediaSource")

function createSendMessage(options = {}) {
 const getSocket = options.getSocket || (() => require("../config/socket").getSocket())
 const prepareMediaSource = options.prepareMediaSource || defaultPrepareMediaSource

 return async function sendMessage(req, res) {
  let source = null
  let sock = null
  let outcome
  let stage = "validation"
  const abort = new AbortController()
  const onClose = () => {
   if (!res.writableFinished) abort.abort()
  }
  res.once?.("close", onClose)

  try {
   const { jid, content, media } = buildMessagePayload(req.body, req.file)
   stage = "connection"
   sock = getSocket()

   if (!sock) {
    outcome = { status: 503, body: { success: false, error: "WhatsApp is not connected" } }
   } else {
    stage = "media"
    if (media) {
     source = await prepareMediaSource(media, { signal: abort.signal })
     content[media.kind] = { stream: source.stream }
     content.mimetype = source.mimetype
     if (media.kind === "sticker" && typeof source.metadata?.animated === "boolean") {
      content.isAnimated = source.metadata.animated
     }
     if (media.kind === "audio" && content.seconds === undefined && Number.isFinite(source.metadata?.duration)) {
      content.seconds = Math.ceil(source.metadata.duration)
     }
    }

    if (getSocket() !== sock) {
     outcome = { status: 503, body: { success: false, error: "WhatsApp is not connected" } }
    } else if (!abort.signal.aborted) {
     stage = "send"
     const result = media
      ? await sock.sendMessage(jid, content, { mediaUploadTimeoutMs: 60000 })
      : await sock.sendMessage(jid, content)
     const body = { success: true, phone: req.body.phone }
     if (typeof result?.key?.id === "string" && result.key.id) body.messageId = result.key.id
     outcome = { status: 200, body }
    }
   }
  } catch (error) {
   if (stage === "validation") {
    outcome = { status: error.status === 413 ? 413 : 400, body: { success: false, error: error.message } }
   } else if (error.expose === true && [400, 413, 415, 502, 504].includes(error.status)) {
    outcome = { status: error.status, body: { success: false, error: error.message } }
   } else if (sock && getSocket() !== sock) {
    outcome = { status: 503, body: { success: false, error: "WhatsApp is not connected" } }
   } else {
    outcome = { status: 502, body: { success: false, error: "Failed to send WhatsApp message" } }
   }
  } finally {
   try {
    await source?.cleanup()
   } catch {
    console.error("Could not close message media resources cleanly")
   }
   try {
    await req.cleanupUpload?.()
   } catch {
    console.error("Could not remove a temporary message upload")
   }
   res.off?.("close", onClose)
  }

  if (abort.signal.aborted || res.destroyed) return
  if (!outcome) outcome = { status: 502, body: { success: false, error: "Failed to send WhatsApp message" } }
  return res.status(outcome.status).json(outcome.body)
 }
}

module.exports = createSendMessage()
module.exports.createSendMessage = createSendMessage

function createQueuedSendMessage(worker) {
 return async (req, res) => {
  let admission = req.queueAdmission
  let acceptedJob
  let stage = "validation"
  if (admission) admission.processing = true
  try {
   if (Object.keys(req.query).some((key) => key !== "wait") ||
       req.query.wait !== undefined && !["true", "false"].includes(req.query.wait)) {
    try { await req.cleanupUpload?.() } catch { if (admission) admission.cleanupFailed = true }
    return res.status(400).json({ success: false, error: "Only the optional wait=true or wait=false query parameter is supported" })
   }
   const built = buildMessagePayload(req.body, req.file)
   stage = "admission"
   admission ||= worker.reserveRequest(req, res)
   const job = await worker.accept(built, admission, async () => {
    try { await req.cleanupUpload?.() }
    catch (error) { admission.cleanupFailed = true; throw error }
   })
   acceptedJob = job
   res.set("Location", `/api/messages/${job.jobId}`)
   const wait = req.query.wait === "true" || req.query.wait === undefined && worker.config.apiMode === "wait"
   if (wait && !res.destroyed) {
    const result = await worker.waitForJob(job.jobId, worker.config.httpWaitMs)
    if (res.destroyed) return
    if (["sent", "delivered", "read"].includes(result?.status)) {
     return res.status(200).json({ success: true, phone: req.body.phone, jobId: job.jobId,
      status: result.status, ...(result.messageId ? { messageId: result.messageId } : {}) })
    }
    if (["failed", "cancelled", "unknown"].includes(result?.status)) {
     return res.status(result.status === "unknown" ? 502 : 503).json({ success: false,
      jobId: job.jobId, status: result.status, error: result.error?.code || "JOB_FAILED" })
    }
    return res.status(202).json({ success: true, jobId: job.jobId,
     status: result?.status || "queued", statusUrl: `/api/messages/${job.jobId}` })
   }
   if (!res.destroyed) return res.status(202).json({ success: true, jobId: job.jobId,
    status: "queued", statusUrl: `/api/messages/${job.jobId}` })
  } catch (error) {
   try { await req.cleanupUpload?.() } catch { if (admission) admission.cleanupFailed = true; console.error("Temporary upload cleanup failed") }
   admission?.release()
   if (res.destroyed) return
   if (acceptedJob) return res.status(202).json({ success: true, jobId: acceptedJob.jobId,
    status: worker.getJob(acceptedJob.jobId)?.status || "queued", statusUrl: `/api/messages/${acceptedJob.jobId}` })
   if (stage === "validation") return res.status(error.status === 413 ? 413 : 400).json({ success: false, error: error.message })
   const status = error.expose && [400, 409, 410, 413, 415, 429, 502, 503, 504].includes(error.status) ? error.status : 500
   if (status === 429) res.set("Retry-After", "1")
   return res.status(status).json({ success: false, error: error.expose ? error.message : "Could not accept message job",
    ...(error.expose && error.code ? { code: error.code } : {}) })
  } finally {
   try { await req.cleanupUpload?.() } catch { if (admission) admission.cleanupFailed = true; console.error("Temporary upload cleanup failed") }
   admission?.release()
  }
 }
}

module.exports.createQueuedSendMessage = createQueuedSendMessage
