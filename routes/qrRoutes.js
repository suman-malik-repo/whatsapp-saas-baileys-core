const path = require("node:path")
const express = require("express")
const QRCode = require("qrcode")
const requireApiKey = require("../middleware/apiKey")

const publicDirectory = path.join(__dirname, "..", "public")
const unavailableMessages = {
 stopped: "WhatsApp is stopped. Start or restart the server to pair.",
 logged_out: "The WhatsApp session has logged out. Request a fresh QR code to pair again.",
 failed: "WhatsApp could not start pairing. Check the server logs and resolve the connection or storage error."
}

function createQrRouter(options = {}) {
 const apiKey = options.apiKey === undefined ? require("../config/apiKey") : options.apiKey
 const getQrStatus = options.getQrStatus || (() => require("../config/socket").getQrStatus())
 const requestQr = options.requestQr || ((request) => require("../config/socket").requestQr(request))
 const authenticate = requireApiKey(apiKey)
 const router = express.Router()
 let cachedQr = null
 let cachedImage = null

 router.use((req, res, next) => {
  res.set({
   "Cache-Control": "no-store",
   "X-Content-Type-Options": "nosniff",
   "X-Frame-Options": "DENY",
   "Referrer-Policy": "no-referrer",
   "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  })
  next()
 })

 router.get("/", (req, res) => res.sendFile(path.join(publicDirectory, "qr.html")))
 router.get("/assets/qr.js", (req, res) => res.sendFile(path.join(publicDirectory, "qr.js")))
 router.get("/assets/qr.css", (req, res) => res.sendFile(path.join(publicDirectory, "qr.css")))

 async function sendSnapshot(res, snapshot) {
  const payload = { ...snapshot, qrImage: null }
  if (payload.connected || unavailableMessages[payload.state] || !payload.qr || !Number.isFinite(Date.parse(payload.expiresAt)) || Date.parse(payload.expiresAt) <= Date.now()) {
   payload.qr = null
   payload.generatedAt = null
   payload.expiresAt = null
  }

  if (payload.qr) {
   if (cachedQr !== payload.qr) {
    const image = await QRCode.toDataURL(payload.qr, { width: 360, margin: 4, errorCorrectionLevel: "M" })
    cachedQr = payload.qr
    cachedImage = image
   }
   payload.qrImage = cachedImage

   if (Date.parse(payload.expiresAt) <= Date.now()) {
    payload.qr = null
    payload.qrImage = null
    payload.generatedAt = null
    payload.expiresAt = null
   }
  } else {
   cachedQr = null
   cachedImage = null
  }

  const error = unavailableMessages[payload.state]
  res.status(error ? 503 : 200).json({ success: !error, ...payload, ...(error ? { error } : {}) })
 }

 router.get("/status", authenticate, async (req, res) => {
  await sendSnapshot(res, getQrStatus())
 })

 router.post("/", authenticate, express.json({ limit: "1kb", strict: false }), async (req, res) => {
  const body = req.body === undefined ? {} : req.body
  if (!body || typeof body !== "object" || Array.isArray(body)) {
   return res.status(400).json({ success: false, error: "Request body must be a JSON object" })
  }
  if (body.fresh !== undefined && typeof body.fresh !== "boolean") {
   return res.status(400).json({ success: false, error: "fresh must be a boolean" })
  }
  if (req.headers["content-type"] && !req.is("application/json")) {
   return res.status(415).json({ success: false, error: "Use Content-Type: application/json" })
  }

  const snapshot = await requestQr({ fresh: body.fresh !== false })
  await sendSnapshot(res, snapshot)
 })

 router.all("/", (req, res) => {
  res.set("Allow", "GET, HEAD, POST")
  res.status(405).json({ success: false, error: "Method not allowed. Use GET or POST /qr" })
 })

 return router
}

module.exports = { createQrRouter }
