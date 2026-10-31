const express = require("express")
const defaultSendMessage = require("../controllers/sendMessage")
const defaultMediaUpload = require("../middleware/mediaUpload")

function createMessageRouter(options = {}) {
 const sendMessage = options.sendMessage || defaultSendMessage
 const mediaUpload = options.mediaUpload || defaultMediaUpload
 const router = express.Router()

 router.post("/send", mediaUpload, sendMessage)

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
