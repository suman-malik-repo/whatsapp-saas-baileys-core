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
