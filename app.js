const express = require("express")
const API_KEY = require("./config/apiKey")
const requireApiKey = require("./middleware/apiKey")
const { createQrRouter } = require("./routes/qrRoutes")

function createApp(options = {}) {
 const apiKey = options.apiKey === undefined ? API_KEY : options.apiKey
 const authenticate = requireApiKey(apiKey)
 const worker = options.worker || (!options.messageRouter ? require("./services/messageWorker").createMessageWorker(options.workerOptions) : null)
 const getConnectionStatus = options.getConnectionStatus || worker?.getConnectionStatus || require("./config/socket").getConnectionStatus
 const messageRouter = options.messageRouter || require("./routes/messageRoutes").createMessageRouter({ worker })
 const app = express()
 app.locals.messageWorker = worker

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

 app.get("/live", (req, res) => res.json({ status: "alive" }))
 app.get("/ready", (req, res) => {
  const readiness = worker ? worker.readiness() : { ready: getConnectionStatus().connected, state: getConnectionStatus().state }
  res.status(readiness.ready ? 200 : 503).json({ status: readiness.ready ? "ready" : "not_ready", state: readiness.state })
 })

 app.use("/qr", createQrRouter({ apiKey, getQrStatus: options.getQrStatus, requestQr: options.requestQr }))

 app.use("/api", authenticate)
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

  if (error.status === 415 && ["encoding.unsupported", "charset.unsupported"].includes(error.type)) {
   return res.status(415).json({ success: false, error: "Unsupported request encoding" })
  }

  if (error.expose === true && [400, 408, 409, 410, 413, 415, 429, 502, 503, 504].includes(error.status)) {
   if (error.status === 429) res.set("Retry-After", "1")
   return res.status(error.status).json({ success: false, error: error.message, ...(error.code ? { code: error.code } : {}) })
  }

  if (error.status === 415) {
   return res.status(415).json({ success: false, error: "Unsupported request encoding" })
  }

  console.error("Request failed")
  res.status(500).json({ success: false, error: "Internal server error" })
 })

 return app
}

module.exports = { createApp }
