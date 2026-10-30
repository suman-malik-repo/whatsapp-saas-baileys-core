const { timingSafeEqual } = require("node:crypto")

function requireApiKey(apiKey) {
 if (typeof apiKey !== "string" || !apiKey.trim()) {
  throw new Error("A nonempty API key is required")
 }

 const expected = Buffer.from(apiKey)

 return function authenticate(req, res, next) {
  const header = req.get("x-api-key")
  const provided = typeof header === "string" ? Buffer.from(header) : null

  if (!provided || provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
   return res.status(401).json({ success: false, error: "Invalid or missing API key" })
  }

  next()
 }
}

module.exports = requireApiKey
