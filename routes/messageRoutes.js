const express = require("express")
const sendMessage = require("../controllers/sendMessage")

const router = express.Router()

router.post("/send", sendMessage)

router.all("/send", (req, res) => {
 res.set("Allow", "POST")
 return res.status(405).json({
  success: false,
  error: "Method not allowed. Use POST /api/send"
 })
})

module.exports = router
