const { createApp } = require("./app")
const { startWhatsApp, stopWhatsApp } = require("./config/socket")

function startServer() {
 const port = process.env.PORT || 3000
 const server = createApp().listen(port)

 server.once("listening", () => {
  console.log("Server running on port", server.address().port)
  startWhatsApp().catch((error) => {
   console.error("WhatsApp startup failed:", error.message)
  })
 })

 server.on("error", (error) => {
  console.error("HTTP server failed:", error.message)
  stopWhatsApp()
  process.exitCode = 1
 })

 return server
}

if (require.main === module) {
 const server = startServer()
 let shuttingDown = false

 const shutdown = async () => {
  if (shuttingDown) return
  shuttingDown = true
  const credentialsDrained = stopWhatsApp()

  const timeout = setTimeout(() => server.closeAllConnections(), 10000)
  timeout.unref()
  server.once("close", () => clearTimeout(timeout))
  server.close()

  try {
   await credentialsDrained
  } catch (error) {
   console.error("Could not finish saving WhatsApp credentials:", error.message)
   process.exitCode = 1
  }
 }

 process.once("SIGINT", shutdown)
 process.once("SIGTERM", shutdown)
}

module.exports = { startServer }
