const { createMessageQueue } = require("./messageQueue")
const { createMediaStaging } = require("./mediaStaging")
const { loadQueueConfig } = require("../config/queue")

function workerError(status, code, message, safeToRetry = false) {
 return Object.assign(new Error(message), { status, code, expose: true, safeToRetry })
}

function createMessageWorker(options = {}) {
 const config = loadQueueConfig(options.env || process.env, options.config || {})
 const sessionId = "default"
 const connection = options.connection || require("../config/socket")
 const getSocket = options.getSocket || connection.getSocket
 const getConnectionStatus = options.getConnectionStatus || connection.getConnectionStatus
 const generateMessageId = options.generateMessageId || ((sock) => require("@whiskeysockets/baileys").generateMessageIDV2(sock.user?.id))
 const staging = options.staging || createMediaStaging({
  maxBytes: config.stagingMaxBytes, maxFiles: config.stagingMaxFiles, ttlMs: config.stagingTtlMs,
  ...(options.prepareMediaSource ? { prepareMediaSource: options.prepareMediaSource } : {})
 })
 let accepting = true
 let uploadCount = 0
 let shutdownPromise
 const admissions = new Set()

 async function processJob(job, { signal, markSending }) {
  let stream
  const abort = () => stream?.destroy()
  signal.addEventListener("abort", abort, { once: true })
  try {
   signal.throwIfAborted()
   const sock = getSocket()
   if (!sock) {
    queue.setConnection(sessionId, getConnectionStatus())
    throw workerError(503, "WHATSAPP_DISCONNECTED", "WhatsApp is not connected", true)
   }
   const { jid, content: original, staged, mediaKind } = job.payload
   const content = structuredClone(original)
   if (staged) {
    stream = staged.open()
    stream.on("error", () => {})
    content[mediaKind] = { stream }
    content.mimetype = staged.mimetype
    if (mediaKind === "sticker") content.isAnimated = staged.metadata.animated
    if (mediaKind === "audio" && content.seconds === undefined) content.seconds = Math.ceil(staged.metadata.duration)
   }
   signal.throwIfAborted()
   if (getSocket() !== sock) {
    queue.setConnection(sessionId, getConnectionStatus())
    throw workerError(503, "WHATSAPP_DISCONNECTED", "WhatsApp is not connected", true)
   }
   const messageId = generateMessageId(sock)
   markSending(messageId)
   // Everything after markSending may have transmitted bytes. The queue treats
   // errors/timeouts here as unknown, regardless of a transport error's label.
   const result = await sock.sendMessage(jid, content, { messageId, mediaUploadTimeoutMs: 60000 })
   if (typeof result?.key?.id !== "string" || !result.key.id) {
    throw workerError(502, "SEND_RESULT_MISSING", "WhatsApp did not return a message identifier")
   }
   return { messageId: result.key.id }
  } finally {
   signal.removeEventListener("abort", abort)
   if (stream && !stream.closed) {
    await new Promise((resolve) => { stream.once("close", resolve); stream.destroy() })
   }
  }
 }

 const queue = options.queue || createMessageQueue({ processJob, config })
 const updateConnection = (snapshot) => queue.setConnection(sessionId, snapshot)
 const unsubscribeConnection = connection.subscribeConnection?.(updateConnection)
 if (!unsubscribeConnection) updateConnection(getConnectionStatus())
 const unsubscribeUpdates = connection.subscribeMessageUpdates?.((update) => {
  queue.updateAck({ ...update, sessionId })
 })

 function reserveRequest(req, res) {
  if (!accepting) throw workerError(503, "WORKER_STOPPING", "The worker is shutting down")
  const multipart = /^multipart\/form-data(?:\s*;|\s*$)/i.test(req.get("Content-Type") || "")
  if (multipart && uploadCount >= config.maxUploads) {
   throw workerError(429, "UPLOAD_CAPACITY_FULL", "Upload capacity is full; retry later")
  }
  const reservation = queue.reserve({ sessionId })
  const controller = new AbortController()
  let finishedAdmission
  const done = new Promise((resolve) => { finishedAdmission = resolve })
  const admission = {
   reservation, signal: controller.signal, committed: false, released: false, done,
   release() {
    if (admission.released) return
    admission.released = true
    if (!admission.committed) reservation.release()
    // Cleanup failure closes this ingress slot until restart, preventing new
    // uploads from accumulating on a disk that cannot remove old files.
    if (multipart && !req.uploadCleanupFailed && !admission.cleanupFailed) uploadCount--
    admissions.delete(admission)
    res.off("finish", onFinish)
    res.off("close", onClose)
    finishedAdmission()
   },
   abort() {
    controller.abort()
    if (!admission.processing) {
     req.destroy()
     Promise.resolve(req.cleanupUpload?.()).catch(() => { admission.cleanupFailed = true }).finally(() => admission.release())
    }
   }
  }
  const onFinish = () => {
   if (admission.processing && !admission.committed) return
   Promise.resolve(req.cleanupUpload?.()).catch(() => { admission.cleanupFailed = true }).finally(() => admission.release())
  }
  const onClose = () => {
   if (!admission.committed) {
    controller.abort()
    // A started controller releases after staging has stopped reading the raw
    // upload. Parser-only errors already await upload cleanup before finishing.
    if (!admission.processing) {
     Promise.resolve(req.cleanupUpload?.()).catch(() => {}).finally(() => admission.release())
    }
   } else admission.release()
  }
  if (multipart) uploadCount++
  admissions.add(admission)
  res.once("finish", onFinish)
  res.once("close", onClose)
  return admission
 }

 async function accept(built, admission, finalizeUpload) {
  let staged
  admission.processing = true
  try {
   if (built.media) staged = await staging.stage(built.media, { signal: admission.signal })
   await finalizeUpload?.()
   admission.signal.throwIfAborted()
   if (!accepting) throw workerError(503, "WORKER_STOPPING", "The worker is shutting down")
   const job = admission.reservation.commit({
    recipient: built.jid,
    metadata: { type: built.media?.requestedType || Object.keys(built.content)[0], mediaSize: staged?.size },
    payload: { jid: built.jid, content: built.content, staged, mediaKind: built.media?.kind },
    cleanup: staged ? () => staged.cleanup() : undefined
   })
   admission.committed = true
   return job
  } catch (error) {
   try { await staged?.cleanup() } catch { console.error("Rejected job media cleanup failed") }
   throw error
  }
 }

 function readiness() {
  const status = getConnectionStatus()
  const metrics = queue.stats(sessionId)
  return { ready: accepting && status.connected && metrics.accepting !== false && metrics.occupiedSlots < config.maxPending,
   state: !accepting ? "draining" : status.state }
 }

 function shutdown({ drainMs = config.drainMs } = {}) {
  if (shutdownPromise) return shutdownPromise
  accepting = false
  queue.stopAdmission()
  staging.stopAdmission()
  for (const admission of admissions) if (!admission.committed) admission.abort()
  shutdownPromise = (async () => {
   await queue.shutdown({ drainMs })
   await staging.shutdown()
   await Promise.allSettled([...admissions].map((admission) => admission.done))
   unsubscribeConnection?.()
   unsubscribeUpdates?.()
  })()
  return shutdownPromise
 }

 return { config, queue, staging, reserveRequest, accept, readiness, shutdown, getConnectionStatus,
  stats: () => ({ ...queue.stats(sessionId), media: staging.stats(), activeUploads: uploadCount }),
  getJob: (id) => queue.getJob(id),
  waitForJob: (id, timeout) => queue.waitForJob(id, timeout) }
}

module.exports = { createMessageWorker }
