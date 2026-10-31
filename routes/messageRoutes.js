const express = require("express")
const defaultSendMessage = require("../controllers/sendMessage")
const defaultMediaUpload = require("../middleware/mediaUpload")

function createMessageRouter(options = {}) {
 const worker = options.worker
 const sendMessage = options.sendMessage || (worker ? defaultSendMessage.createQueuedSendMessage(worker) : defaultSendMessage)
 const mediaUpload = options.mediaUpload || defaultMediaUpload
 const router = express.Router()

 router.post("/send", (req, res, next) => {
  const contentType = req.get("Content-Type") || ""
  if (!/^(?:application\/json|multipart\/form-data)(?:\s*;|\s*$)/i.test(contentType)) {
   return res.status(415).json({ success: false, error: "Use Content-Type application/json or multipart/form-data" })
  }
  next()
 }, (req, res, next) => {
  if (!worker) return next()
  try { req.queueAdmission = worker.reserveRequest(req, res); next() }
  catch (error) { next(error) }
 }, mediaUpload, sendMessage)

 if (worker) {
  router.get("/messages/:jobId", (req, res) => {
   if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(req.params.jobId) || Object.keys(req.query).length) {
    return res.status(400).json({ success: false, error: "Invalid job ID or query parameters" })
   }
   const job = worker.getJob(req.params.jobId)
   if (!job) return res.status(404).json({ success: false, error: "Job not found or no longer retained" })
   res.json({ success: true, job })
  })
  router.get("/queue/stats", (req, res) => {
   if (Object.keys(req.query).length) return res.status(400).json({ success: false, error: "Query parameters are not supported" })
   res.json({ success: true, queue: worker.stats() })
  })
 }

 router.all("/send", (req, res) => {
  res.set("Allow", "POST")
  return res.status(405).json({
   success: false,
   error: "Method not allowed. Use POST /api/send"
  })
 })

 return router
}

module.exports = createMessageRouter()
module.exports.createMessageRouter = createMessageRouter
