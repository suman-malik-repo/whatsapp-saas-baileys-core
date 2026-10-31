const path = require("node:path")
const formatPhone = require("./formatPhone")

const MiB = 1024 * 1024
// Deliberate server limits; these are not WhatsApp's advertised media limits.
const MEDIA_LIMITS = Object.freeze({
 image: 10 * MiB, video: 50 * MiB, audio: 16 * MiB,
 voice: 16 * MiB, document: 100 * MiB, sticker: MiB
})
const MEDIA_FIELDS = {
 image: ["caption", "viewOnce"],
 video: ["caption", "gifPlayback", "viewOnce"],
 audio: ["ptt", "seconds", "viewOnce"],
 voice: ["seconds", "viewOnce"],
 document: ["caption", "fileName"],
 sticker: ["isAnimated"]
}
const DEFAULT_MIMES = {
 image: "image/jpeg", video: "video/mp4", audio: "audio/mpeg",
 voice: "audio/ogg; codecs=opus", document: "application/octet-stream", sticker: "image/webp"
}
const SUPPORTED_MIMES = {
 image: ["image/jpeg", "image/png", "image/webp"],
 video: ["video/mp4"],
 audio: ["audio/mpeg", "audio/ogg", "audio/mp4", "audio/aac", "audio/wav"],
 voice: ["audio/ogg"], sticker: ["image/webp"]
}
const MIME_ALIASES = {
 "image/jpg": "image/jpeg", "audio/mp3": "audio/mpeg", "audio/x-wav": "audio/wav",
 "audio/wave": "audio/wav", "audio/x-m4a": "audio/mp4", "audio/opus": "audio/ogg"
}
const EXTENSION_MIMES = {
 ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
 ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif",
 ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
 ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac",
 ".ogg": "audio/ogg", ".opus": "audio/ogg; codecs=opus", ".wav": "audio/wav", ".flac": "audio/flac",
 ".pdf": "application/pdf", ".txt": "text/plain", ".csv": "text/csv", ".json": "application/json",
 ".zip": "application/zip", ".doc": "application/msword",
 ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
 ".xls": "application/vnd.ms-excel",
 ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
 ".ppt": "application/vnd.ms-powerpoint",
 ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation"
}

function invalid(message, status = 400) {
 const error = new Error(message)
 error.status = status
 throw error
}

function object(value, label) {
 if (!value || typeof value !== "object" || Array.isArray(value) ||
     ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
  invalid(`${label} must be an object`)
 }
}

function fields(value, allowed, label) {
 for (const key of Object.keys(value)) {
  if (!allowed.includes(key)) invalid(`Unexpected ${label} field: ${key}`)
 }
}

function string(value, label, max, { allowEmpty = false, controls = true } = {}) {
 if (typeof value !== "string") invalid(`${label} must be a string`)
 if (!value.isWellFormed()) invalid(`${label} must contain valid Unicode`)
 if (!allowEmpty && !/[^\p{White_Space}\p{Default_Ignorable_Code_Point}]/u.test(value)) invalid(`${label} must not be empty or invisible`)
 if (value.length > max) invalid(`${label} must be at most ${max} characters`)
 const forbiddenControls = controls ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u : /[\u0000-\u001f\u007f-\u009f]/u
 if (forbiddenControls.test(value)) invalid(`${label} must not contain control characters`)
 return value
}

function boolean(value, label, multipart) {
 if (multipart && (value === "true" || value === "false")) return value === "true"
 if (typeof value !== "boolean") invalid(`${label} must be a boolean`)
 return value
}

function number(value, label, min, max) {
 if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
  invalid(`${label} must be a finite number between ${min} and ${max}`)
 }
 return value
}

function normalizedPhone(phone, label = "phone") {
 try {
  return formatPhone(phone)
 } catch (error) {
  invalid(label === "phone" ? error.message : `${label}: ${error.message}`)
 }
}

function mediaUrl(value) {
 string(value, "url", 2048, { controls: false })
 if (!/^https?:\/\//i.test(value) || /[\s\\]/u.test(value)) invalid("url must be an absolute HTTP or HTTPS URL without whitespace or backslashes")
 let url
 try { url = new URL(value) } catch { invalid("url must be a valid HTTP or HTTPS URL") }
 if (!url.hostname || url.username || url.password) invalid("url must have a hostname and must not contain credentials")
 if (value.includes("#")) invalid("url must not contain a fragment")
 if (url.port && url.port !== (url.protocol === "http:" ? "80" : "443")) invalid("url must use the standard HTTP or HTTPS port")
 if (url.href.length > 2048) invalid("url must be at most 2048 characters after normalization")
 return url
}

function urlFilename(url) {
 if (!url) return ""
 try { return path.posix.basename(decodeURIComponent(url.pathname)) } catch { return "" }
}

function filename(value, label) {
 string(value, label, 255, { controls: false })
 if (/[\\/]/.test(value) || value === "." || value === "..") invalid(`${label} must be a filename without a directory`)
 return value
}

function mime(value, type, ptt) {
 string(value, "mimetype", 200, { controls: false })
 const [rawBase, ...rawParameters] = value.toLowerCase().trim().split(";")
 const base = MIME_ALIASES[rawBase.trim()] || rawBase.trim()
 if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(base)) {
  invalid("mimetype must be a valid MIME type")
 }
 const parameters = new Map()
 for (const parameter of rawParameters) {
  const match = /^\s*([a-z0-9_-]+)\s*=\s*([a-z0-9_.+-]+|"[a-z0-9_.+-]+")\s*$/.exec(parameter)
  if (!match) invalid("mimetype must be a valid MIME type")
  const [, key, rawValue] = match
  if (parameters.has(key)) invalid(`mimetype must not repeat the ${key} parameter`)
  parameters.set(key, rawValue.replace(/^"|"$/g, ""))
 }
 const family = { image: "image/", video: "video/", audio: "audio/", voice: "audio/" }[type]
 if (family && !base.startsWith(family)) invalid(`mimetype is not compatible with ${type}`)
 if (type === "sticker" && base !== "image/webp") invalid("Stickers must use image/webp")
 if ((type === "voice" || ptt) && (base !== "audio/ogg" ||
     parameters.has("codecs") && parameters.get("codecs") !== "opus")) {
  invalid("Voice notes require Ogg/Opus audio; automatic transcoding is not provided")
 }
 if (SUPPORTED_MIMES[type] && !SUPPORTED_MIMES[type].includes(base)) invalid(`Unsupported ${type} MIME type`)
 return base + [...parameters].map(([key, parameter]) => `; ${key}=${parameter}`).join("")
}

function buildMedia(body, type, file) {
 fields(body, ["phone", "type", "url", "mimetype", ...MEDIA_FIELDS[type]], "request")
 const hasUrl = Object.hasOwn(body, "url")
 if (hasUrl === Boolean(file)) invalid("Provide exactly one media source: url or multipart file")
 const url = hasUrl ? mediaUrl(body.url) : null
 if (file) {
  if (typeof file.path !== "string" || !file.path || /[\u0000-\u001f]/.test(file.path)) invalid("Invalid uploaded file")
  if (!Number.isSafeInteger(file.size) || file.size <= 0) invalid("Uploaded file must not be empty")
  if (file.size > MEDIA_LIMITS[type]) invalid(`Media exceeds the ${MEDIA_LIMITS[type]} byte limit for ${type}`, 413)
 }

 const multipart = Boolean(file)
 const content = {}
 if (Object.hasOwn(body, "caption")) content.caption = string(body.caption, "caption", 1024, { allowEmpty: true })
 for (const key of ["viewOnce", "gifPlayback", "ptt", "isAnimated"]) {
  if (Object.hasOwn(body, key)) content[key] = boolean(body[key], key, multipart)
 }
 if (type === "voice") content.ptt = true
 if (Object.hasOwn(body, "seconds")) {
  const seconds = multipart && typeof body.seconds === "string" && /^\d+$/.test(body.seconds) ? Number(body.seconds) : body.seconds
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 86400) invalid("seconds must be an integer between 0 and 86400")
  content.seconds = seconds
 }

 const sourceName = file ? path.win32.basename(file.originalname || "") : urlFilename(url)
 const inferredMime = EXTENSION_MIMES[path.extname(sourceName).toLowerCase()]
 const uploadedMime = file?.mimetype && file.mimetype !== "application/octet-stream" ? file.mimetype : null
 const fallback = content.ptt ? DEFAULT_MIMES.voice : DEFAULT_MIMES[type]
 content.mimetype = mime(Object.hasOwn(body, "mimetype") ? body.mimetype : uploadedMime ?? inferredMime ?? fallback, type, content.ptt)
 if (type === "document") {
  content.fileName = filename(Object.hasOwn(body, "fileName") ? body.fileName : sourceName || "document", "fileName")
 }
 return {
  content,
  media: {
   kind: type === "voice" ? "audio" : type,
   requestedType: type,
   mimetypeExplicit: Object.hasOwn(body, "mimetype"),
   mimetype: content.mimetype,
   ptt: content.ptt === true,
   ...(Object.hasOwn(content, "isAnimated") ? { isAnimated: content.isAnimated } : {}),
   ...(url ? { url: url.href } : { file }),
   maxBytes: MEDIA_LIMITS[type]
  }
 }
}

function buildLocation(body) {
 fields(body, ["phone", "type", "location"], "request")
 object(body.location, "location")
 fields(body.location, ["latitude", "longitude", "name", "address"], "location")
 const location = {
  degreesLatitude: number(body.location.latitude, "location.latitude", -90, 90),
  degreesLongitude: number(body.location.longitude, "location.longitude", -180, 180)
 }
 for (const [key, max] of [["name", 256], ["address", 1024]]) {
  if (Object.hasOwn(body.location, key)) location[key] = string(body.location[key], `location.${key}`, max, { controls: false })
 }
 return { location }
}

function escapeVcard(value) {
 return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,")
}

function buildContacts(body) {
 fields(body, ["phone", "type", "contacts", "displayName"], "request")
 if (!Array.isArray(body.contacts) || body.contacts.length < 1 || body.contacts.length > 20) {
  invalid("contacts must contain between 1 and 20 contact objects")
 }
 const contacts = body.contacts.map((contact, index) => {
  const label = `contacts[${index}]`
  object(contact, label)
  fields(contact, ["name", "phone", "organization", "email"], label)
  const name = string(contact.name, `${label}.name`, 256, { controls: false })
  const digits = normalizedPhone(contact.phone, `${label}.phone`).split("@", 1)[0]
  const lines = ["BEGIN:VCARD", "VERSION:3.0", `FN:${escapeVcard(name)}`, `N:;${escapeVcard(name)};;;`,
   `TEL;TYPE=CELL;TYPE=VOICE;waid=${digits}:+${digits}`]
  if (Object.hasOwn(contact, "organization")) {
   lines.push(`ORG:${escapeVcard(string(contact.organization, `${label}.organization`, 256, { controls: false }))}`)
  }
  if (Object.hasOwn(contact, "email")) {
   const email = string(contact.email, `${label}.email`, 254, { controls: false })
   const parts = email.split("@")
   const local = parts[0]
   const domain = parts[1]
   if (parts.length !== 2 || local.length > 64 || !/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/i.test(local) ||
       local.startsWith(".") || local.endsWith(".") || local.includes("..") || !domain || domain.length > 253 ||
       !domain.includes(".") || !domain.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part))) {
    invalid(`${label}.email must be a valid email address`)
   }
   lines.push(`EMAIL;TYPE=INTERNET:${escapeVcard(email)}`)
  }
  lines.push("END:VCARD")
  return { displayName: name, vcard: lines.join("\r\n") }
 })
 const displayName = Object.hasOwn(body, "displayName") ?
  string(body.displayName, "displayName", 256, { controls: false }) :
  contacts.length === 1 ? contacts[0].displayName : `${contacts.length} contacts`
 return { contacts: { displayName, contacts } }
}

function buildPoll(body) {
 fields(body, ["phone", "type", "poll"], "request")
 object(body.poll, "poll")
 fields(body.poll, ["name", "options", "selectableCount"], "poll")
 const name = string(body.poll.name, "poll.name", 256, { controls: false })
 if (!Array.isArray(body.poll.options) || body.poll.options.length < 2 || body.poll.options.length > 12) {
  invalid("poll.options must contain between 2 and 12 strings")
 }
 const values = body.poll.options.map((value, index) => string(value, `poll.options[${index}]`, 100, { controls: false }))
 if (new Set(values.map((value) => value.normalize("NFC").trim().toLowerCase())).size !== values.length) invalid("poll.options must be unique")
 const selectableCount = Object.hasOwn(body.poll, "selectableCount") ? body.poll.selectableCount : 1
 if (!Number.isInteger(selectableCount) || selectableCount < 1 || selectableCount > values.length) {
  invalid("poll.selectableCount must be an integer between 1 and the number of options")
 }
 return { poll: { name, values, selectableCount } }
}

function buildMessagePayload(body, file = null) {
 object(body, "Request body")
 const type = Object.hasOwn(body, "type") ? body.type : "text"
 if (typeof type !== "string" || !["text", ...Object.keys(MEDIA_FIELDS), "location", "contacts", "poll"].includes(type)) {
  invalid("type must be text, image, video, audio, voice, document, sticker, location, contacts or poll")
 }
 const jid = normalizedPhone(body.phone)
 if (Object.hasOwn(MEDIA_FIELDS, type)) return { jid, ...buildMedia(body, type, file) }
 if (file) invalid(`File uploads are not supported for ${type} messages`)
 let content
 if (type === "text") {
  fields(body, ["phone", "type", "message"], "request")
  content = { text: string(body.message, "message", 4096) }
 } else if (type === "location") content = buildLocation(body)
 else if (type === "contacts") content = buildContacts(body)
 else content = buildPoll(body)
 return { jid, content, media: null }
}

module.exports = { buildMessagePayload, MEDIA_LIMITS }
