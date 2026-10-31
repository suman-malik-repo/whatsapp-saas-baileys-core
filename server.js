const { createApp } = require("./app")
const { createMessageWorker } = require("./services/messageWorker")

function startServer(options = {}) {
 const connection = options.connection || require("./config/socket")
 const worker = options.worker || createMessageWorker({ connection, ...options.workerOptions })
 const app = createApp({ worker, ...options.appOptions })
 const server = app.listen(options.port ?? process.env.PORT ?? 3000, options.host || "0.0.0.0")
 let shutdownPromise

 server.once("listening", () => {
  if (shutdownPromise) return
  console.log("Server running on port", server.address().port)
  Promise.resolve().then(() => { if (!shutdownPromise) return connection.startWhatsApp() }).catch(() => {
   console.error("WhatsApp startup failed")
  })
 })
 server.on("error", () => {
  console.error("HTTP server failed")
  void shutdown().catch(() => console.error("Worker shutdown failed"))
  process.exitCode = 1
 })

 function shutdown() {
  if (shutdownPromise) return shutdownPromise
  const drain = worker.shutdown()
  const httpClosed = new Promise((resolve) => server.close(() => resolve()))
  const timeout = setTimeout(() => server.closeAllConnections(), worker.config.drainMs + 1000)
  timeout.unref?.()
  shutdownPromise = (async () => {
   try { await drain }
   finally {
    // Preserve the connection for active-send draining, then save credentials
    // and close the transport without logging out the linked account.
    try { await connection.stopWhatsApp() }
    finally {
     server.closeAllConnections()
     await httpClosed
     clearTimeout(timeout)
    }
   }
  })()
  return shutdownPromise
 }

 server.shutdown = shutdown
 server.messageWorker = worker
 return server
}

if (require.main === module) {
 const server = startServer()
 let shuttingDown = false
 const shutdown = () => {
  if (shuttingDown) return
  shuttingDown = true
  const deadline = setTimeout(() => {
   console.error("Worker shutdown deadline exceeded; unfinished sends require reconciliation")
   process.exit(1)
  }, server.messageWorker.config.drainMs + 15000)
  deadline.unref()
  server.shutdown().catch(() => {
   console.error("Worker shutdown did not finish cleanly")
   process.exitCode = 1
  }).finally(() => clearTimeout(deadline))
 }
 process.once("SIGINT", shutdown)
 process.once("SIGTERM", shutdown)
}

module.exports = { startServer }
