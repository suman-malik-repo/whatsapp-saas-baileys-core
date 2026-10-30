const express = require("express")
const API_KEY = require("./config/apiKey")
const requireApiKey = require("./middleware/apiKey")
const { createQrRouter } = require("./routes/qrRoutes")

function createApp(options = {}) {
 const apiKey = options.apiKey === undefined ? API_KEY : options.apiKey
 const getConnectionStatus = options.getConnectionStatus || require("./config/socket").getConnectionStatus
 const messageRouter = options.messageRouter || require("./routes/messageRoutes")
 const app = express()

 app.disable("x-powered-by")
 app.use((req, res, next) => {
  res.set("Cache-Control", "no-store")
  next()
 })

 app.get("/ping", (req, res) => {
  const whatsapp = getConnectionStatus()

  res.status(whatsapp.connected ? 200 : 503).json({
   status: whatsapp.connected ? "ready" : "not_ready",
   time: new Date().toISOString(),
   whatsapp
  })
 })

 app.use("/qr", createQrRouter({ apiKey, getQrStatus: options.getQrStatus, requestQr: options.requestQr }))

 app.use("/api", requireApiKey(apiKey))
 app.use(express.json({ limit: "32kb" }))
 app.use("/api", messageRouter)

 app.use((req, res) => {
  res.status(404).json({ success: false, error: "Not found" })
 })

 app.use((error, req, res, next) => {
  if (res.headersSent) return next(error)

  if (error.type === "entity.parse.failed") {
   return res.status(400).json({ success: false, error: "Invalid JSON body" })
  }

  if (error.type === "entity.too.large") {
   return res.status(413).json({ success: false, error: "Request body is too large" })
  }

  if (error.status === 415) {
   return res.status(415).json({ success: false, error: "Unsupported request encoding" })
  }

  console.error("Request failed:", error.message)
  res.status(500).json({ success: false, error: "Internal server error" })
 })

 return app
}

module.exports = { createApp }
