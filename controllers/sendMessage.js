const { getSocket } = require("../config/socket")
const formatPhone = require("../utils/formatPhone")

const MAX_MESSAGE_LENGTH = 4096

async function sendMessage(req, res) {
 const body = req.body

 if (!body || typeof body !== "object" || Array.isArray(body) ||
     ![Object.prototype, null].includes(Object.getPrototypeOf(body))) {
  return res.status(400).json({
   success: false,
   error: "Request body must be a JSON object"
  })
 }

 const { phone, message } = body

 if (typeof phone !== "string" || typeof message !== "string") {
  return res.status(400).json({
   success: false,
   error: "phone and message must be strings"
  })
 }

 if (!message.trim()) {
  return res.status(400).json({
   success: false,
   error: "message must not be empty"
  })
 }

 if (message.length > MAX_MESSAGE_LENGTH) {
  return res.status(400).json({
   success: false,
   error: `message must be at most ${MAX_MESSAGE_LENGTH} characters`
  })
 }

 let jid
 try {
  jid = formatPhone(phone)
 } catch (error) {
  return res.status(400).json({ success: false, error: error.message })
 }

 const sock = getSocket()
 if (!sock) {
  return res.status(503).json({
   success: false,
   error: "WhatsApp is not connected"
  })
 }

 try {
  const result = await sock.sendMessage(jid, { text: message })
  const response = { success: true, phone }

  if (typeof result?.key?.id === "string" && result.key.id) {
   response.messageId = result.key.id
  }

  return res.json(response)
 } catch (error) {
  if (getSocket() !== sock) {
   return res.status(503).json({
    success: false,
    error: "WhatsApp is not connected"
   })
  }

  return res.status(502).json({
   success: false,
   error: "Failed to send WhatsApp message"
  })
 }
}

module.exports = sendMessage
