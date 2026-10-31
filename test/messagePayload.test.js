const assert = require("node:assert/strict")
const test = require("node:test")
const { buildMessagePayload: build, MEDIA_LIMITS } = require("../utils/messagePayload")

const phone = "12025550123"
const request = (type, extra = {}) => ({ phone, type, ...extra })
const upload = (extra = {}) => ({ path: "C:\\Temp\\upload", originalname: "photo.jpg", mimetype: "image/jpeg", size: 100, ...extra })
function invalid(body, file = null, status = 400, message) {
 assert.throws(() => build(body, file), (error) => error.status === status && (!message || message.test(error.message)))
}

test("legacy text remains compatible and normalizes the destination", () => {
 assert.deepEqual(build({ phone: "+1 (202) 555-0123", message: "  hello\n " }), {
  jid: `${phone}@s.whatsapp.net`, content: { text: "  hello\n " }, media: null
 })
 assert.equal(build(request("text", { message: "x".repeat(4096) })).content.text.length, 4096)
 for (const message of [undefined, null, {}, 10, "", "  \n\t", "x".repeat(4097)]) {
  invalid(request("text", { message }))
 }
})

test("request objects, destination phones and types are validated without coercion", () => {
 for (const body of [undefined, null, [], "hello", 123, new Date(), Object.create({ phone })]) invalid(body)
 for (const value of [undefined, null, [], {}, phone.length, "123", "0123456789", "123@g.us", "1234567@s.whatsapp.net"]) {
  invalid({ phone: value, message: "hello" })
 }
 for (const type of [null, undefined, "", "TEXT", "unknown", {}, ["text"]]) invalid(request(type, { message: "hello" }))
 const nullPrototype = Object.assign(Object.create(null), { phone, message: "hello" })
 assert.equal(build(nullPrototype).content.text, "hello")
})

test("unknown fields and inappropriate optional fields are rejected", () => {
 for (const body of [
  { phone, message: "hello", caption: "not text" },
  request("image", { url: "https://example.com/photo.jpg", message: "not caption" }),
  request("audio", { url: "https://example.com/song.mp3", caption: "unsupported" }),
  request("document", { url: "https://example.com/book.pdf", viewOnce: true }),
  request("sticker", { url: "https://example.com/sticker.webp", fileName: "sticker.webp" }),
  JSON.parse(`{"phone":"${phone}","message":"hello","__proto__":{}}`)
 ]) invalid(body)
})

test("image URLs produce upload metadata without fetching or embedding the source", () => {
 const result = build(request("image", { url: "https://example.com/photo.png?token=test", caption: "photo", viewOnce: false }))
 assert.deepEqual(result.content, { mimetype: "image/png", caption: "photo", viewOnce: false })
 assert.deepEqual(result.media, {
  kind: "image", requestedType: "image", mimetypeExplicit: false, mimetype: "image/png", ptt: false,
  url: "https://example.com/photo.png?token=test", maxBytes: 10 * 1024 * 1024
 })
 assert.equal(result.jid, `${phone}@s.whatsapp.net`)
 assert.equal(Object.hasOwn(result.content, "image"), false)
})

test("video options, empty captions and explicit false values survive", () => {
 const { content, media } = build(request("video", {
  url: "https://example.com/movie.mp4", caption: "", gifPlayback: false, viewOnce: true
 }))
 assert.deepEqual(content, { caption: "", gifPlayback: false, viewOnce: true, mimetype: "video/mp4" })
 assert.equal(media.kind, "video")
 assert.equal(media.maxBytes, 50 * 1024 * 1024)
 invalid(request("video", { url: "https://example.com/movie.mp4", gifPlayback: "true" }))
})

test("audio and voice support optional duration and view-once with Opus enforcement", () => {
 const { content, media } = build(request("audio", {
  url: "https://example.com/song.mp3", seconds: 0, ptt: false, viewOnce: false
 }))
 assert.deepEqual(content, { ptt: false, seconds: 0, viewOnce: false, mimetype: "audio/mpeg" })
 assert.equal(media.kind, "audio")
 assert.equal(media.ptt, false)
 const voice = build(request("voice", { url: "https://example.com/note.opus", seconds: 4, viewOnce: true }))
 assert.deepEqual(voice.content, { ptt: true, seconds: 4, viewOnce: true, mimetype: "audio/ogg; codecs=opus" })
 assert.equal(voice.media.kind, "audio")
 assert.equal(voice.media.requestedType, "voice")
 assert.equal(voice.media.ptt, true)
 const ptt = build(request("audio", { url: "https://example.com/voice.ogg", ptt: true }))
 assert.equal(ptt.content.ptt, true)
 for (const type of ["voice", "audio"]) {
  const extra = type === "audio" ? { ptt: true } : {}
  for (const mimetype of ["audio/mpeg", "audio/wav", "audio/ogg; codecs=vorbis"]) {
   invalid(request(type, { url: "https://example.com/file", mimetype, ...extra }), null, 400, /Ogg\/Opus/)
  }
 }
 invalid(request("voice", { url: "https://example.com/note.ogg", ptt: false }))
 for (const seconds of [-1, 0.5, 4.25, NaN, Infinity, "1", 86401, {}, null]) {
  invalid(request("audio", { url: "https://example.com/song.mp3", seconds }))
 }
 assert.equal(build(request("audio", { url: "https://example.com/song.mp3", seconds: 86400 })).content.seconds, 86400)
})

test("document MIME and filename are inferred, or use the supplied optional fields", () => {
 const inferred = build(request("document", { url: "https://example.com/reports/Annual%20Report.pdf?token=secret" }))
 assert.deepEqual(inferred.content, { mimetype: "application/pdf", fileName: "Annual Report.pdf" })
 const explicit = build(request("document", {
  url: "https://example.com/download", fileName: "report.csv", mimetype: "text/csv", caption: "Results"
 }))
 assert.deepEqual(explicit.content, { caption: "Results", mimetype: "text/csv", fileName: "report.csv" })
 assert.equal(explicit.media.mimetypeExplicit, true)
 const noName = build(request("document", { url: "https://example.com/" }))
 assert.equal(noName.content.fileName, "document")
 assert.equal(noName.content.mimetype, "application/octet-stream")
 for (const fileName of ["", "../report.pdf", "C:\\report.pdf", ".", "..", "report\r\nX:injected", "x".repeat(256), null]) {
  invalid(request("document", { url: "https://example.com/report.pdf", fileName }))
 }
})

test("stickers accept WebP and preserve animation intent", () => {
 const result = build(request("sticker", { url: "https://example.com/sticker.webp", isAnimated: true }))
 assert.deepEqual(result.content, { mimetype: "image/webp", isAnimated: true })
 assert.equal(result.media.isAnimated, true)
 assert.equal(build(request("sticker", { url: "https://example.com/sticker.webp", isAnimated: false })).media.isAnimated, false)
 assert.equal(Object.hasOwn(build(request("sticker", { url: "https://example.com/sticker.webp" })).media, "isAnimated"), false)
 assert.equal(result.media.maxBytes, 1024 * 1024)
 invalid(request("sticker", { url: "https://example.com/sticker.png" }), null, 400, /WebP|webp/)
 invalid(request("sticker", { url: "https://example.com/sticker.webp", isAnimated: "true" }))
})

test("media source exclusivity and URL syntax are enforced before any network call", () => {
 invalid(request("image"))
 invalid(request("image", { url: null }))
 invalid(request("image", { url: "https://example.com/p.jpg" }), upload())
 for (const url of ["file:///etc/passwd", "data:image/png;base64,AA==", "ftp://example.com/a", "http:example.com/a",
  "https://user:pass@example.com/a", "https://user@example.com/a", " https://example.com/a", "https://example.com/\nfile", "https://", 123]) {
  invalid(request("image", { url }))
 }
 invalid(request("image", { url: `https://example.com/${"x".repeat(2048)}` }))
 assert.equal(build(request("image", { url: "HTTPS://example.com/a" })).media.url, "https://example.com/a")
})

test("MIME types are inferred per source and explicit MIME must match the requested category", () => {
 assert.equal(build(request("image", { url: "https://example.com/no-extension" })).content.mimetype, "image/jpeg")
 assert.equal(build(request("audio", { url: "https://example.com/no-extension", ptt: true })).content.mimetype, "audio/ogg; codecs=opus")
 const explicit = build(request("image", { url: "https://example.com/payload", mimetype: "IMAGE/PNG" }))
 assert.equal(explicit.content.mimetype, "image/png")
 assert.equal(explicit.media.mimetypeExplicit, true)
 for (const mimetype of [null, "", "png", "text/plain", "image/png\r\nX:injected", {}, "image/png; bad=hello world"]) {
  invalid(request("image", { url: "https://example.com/p.png", mimetype }))
 }
 invalid(request("image", { url: "https://example.com/report.pdf" }))
 invalid(request("video", { url: "https://example.com/movie.mp4", mimetype: "image/png" }))
 invalid(request("audio", { url: "https://example.com/song.mp3", mimetype: "video/mp4" }))
})

test("uploads use source metadata and coerce only multipart boolean and numeric fields", () => {
 const file = upload({ originalname: "voice.opus", mimetype: "audio/ogg; codecs=opus" })
 const result = build(request("voice", { seconds: "1", viewOnce: "false" }), file)
 assert.deepEqual(result.content, { ptt: true, seconds: 1, viewOnce: false, mimetype: "audio/ogg; codecs=opus" })
 assert.equal(result.media.file, file)
 assert.equal(Object.hasOwn(result.media, "url"), false)
 assert.equal(build(request("video", { gifPlayback: "true", viewOnce: "false" }), upload({ originalname: "movie.mp4", mimetype: "video/mp4" })).content.gifPlayback, true)
 assert.equal(build(request("document"), upload({ originalname: "report.pdf", mimetype: "application/octet-stream" })).content.fileName, "report.pdf")
 assert.equal(build(request("document"), upload({ originalname: "report.pdf", mimetype: "application/octet-stream" })).content.mimetype, "application/pdf")
 for (const seconds of ["", " ", "NaN", "Infinity", "0x10", "1e2", "-1", "1.5", "1.0", "+1", "1\n"]) {
  invalid(request("voice", { seconds }), file)
 }
 for (const viewOnce of ["1", "0", "TRUE", "False", 1, null, []]) {
  invalid(request("voice", { viewOnce }), file)
 }
})

test("upload validation enforces each configured size limit and rejects empty or malformed files", () => {
 const names = { image: "p.jpg", video: "p.mp4", audio: "p.mp3", voice: "p.opus", document: "p.pdf", sticker: "p.webp" }
 for (const [type, limit] of Object.entries(MEDIA_LIMITS)) {
  const file = upload({ originalname: names[type], mimetype: "application/octet-stream", size: limit })
  assert.equal(build(request(type), file).media.maxBytes, limit)
  invalid(request(type), { ...file, size: limit + 1 }, 413)
 }
 for (const file of [upload({ size: 0 }), upload({ size: -1 }), upload({ size: NaN }), upload({ size: 1.5 }),
  upload({ path: "" }), upload({ path: "\0" }), upload({ path: undefined })]) invalid(request("image"), file)
 for (const body of [{ phone, message: "hello" }, request("location", { location: { latitude: 0, longitude: 0 } }),
  request("contacts", { contacts: [{ name: "Alice", phone }] }), request("poll", { poll: { name: "Choose", options: ["A", "B"] } })]) {
  invalid(body, upload())
 }
})

test("captions allow their boundary and reject excessive or non-string captions", () => {
 assert.equal(build(request("image", { url: "https://example.com/p.jpg", caption: "x".repeat(1024) })).content.caption.length, 1024)
 for (const caption of ["x".repeat(1025), undefined, null, 1, []]) {
  invalid(request("image", { url: "https://example.com/p.jpg", caption }))
 }
})

test("static location maps coordinates and optional labels without losing zero", () => {
 assert.deepEqual(build(request("location", { location: { latitude: 0, longitude: 0, name: "Office", address: "123 Main Street" } })).content, {
  location: { degreesLatitude: 0, degreesLongitude: 0, name: "Office", address: "123 Main Street" }
 })
 assert.deepEqual(build(request("location", { location: { latitude: -90, longitude: 180 } })).content.location, { degreesLatitude: -90, degreesLongitude: 180 })
 assert.deepEqual(build(request("location", { location: { latitude: 90, longitude: -180 } })).content.location, { degreesLatitude: 90, degreesLongitude: -180 })
})

test("locations reject missing, out-of-range, non-numeric and unsupported fields", () => {
 for (const location of [null, [], "location", {}, { latitude: 1 }, { latitude: "0", longitude: 0 }, { latitude: 0, longitude: NaN },
  { latitude: 90.1, longitude: 0 }, { latitude: 0, longitude: -180.1 }, { latitude: 0, longitude: 0, live: true },
  { latitude: 0, longitude: 0, name: "x".repeat(257) }, { latitude: 0, longitude: 0, address: "x".repeat(1025) }]) {
  invalid(request("location", { location }))
 }
})

test("contact cards create escaped vCard 3.0 records and normalized telephone waids", () => {
 const name = "Alice, Example; Team\\Sales"
 const { content, media } = build(request("contacts", {
  contacts: [{ name, phone: "+1 (202) 555-0123", organization: "Example; Ltd", email: "alice@example.com" }]
 }))
 assert.equal(media, null)
 assert.equal(content.contacts.displayName, name)
 assert.equal(content.contacts.contacts[0].displayName, name)
 assert.equal(content.contacts.contacts[0].vcard, [
  "BEGIN:VCARD", "VERSION:3.0", "FN:Alice\\, Example\\; Team\\\\Sales", "N:;Alice\\, Example\\; Team\\\\Sales;;;",
  `TEL;TYPE=CELL;TYPE=VOICE;waid=${phone}:+${phone}`, "ORG:Example\\; Ltd", "EMAIL;TYPE=INTERNET:alice@example.com", "END:VCARD"
 ].join("\r\n"))
 const multi = build(request("contacts", { displayName: "Team", contacts: [{ name: "Alice", phone }, { name: "Bob", phone }] }))
 assert.equal(multi.content.contacts.displayName, "Team")
 assert.equal(multi.content.contacts.contacts.length, 2)
 assert.equal(build(request("contacts", { contacts: [{ name: "Alice", phone }, { name: "Bob", phone }] })).content.contacts.displayName, "2 contacts")
})

test("contact validation rejects injection, invalid phone or email, excessive counts and unknown fields", () => {
 for (const contacts of [undefined, null, {}, [], Array.from({ length: 21 }, () => ({ name: "Alice", phone })),
  [null], [{ name: "Alice", phone: "invalid" }], [{ name: "", phone }], [{ name: "x".repeat(257), phone }],
  [{ name: "Alice\r\nEND:VCARD", phone }], [{ name: "Alice", phone, organization: "Org\nTEL:evil" }],
  [{ name: "Alice", phone, email: "alice@example.com\r\nTEL:evil" }], [{ name: "Alice", phone, email: "invalid" }],
  [{ name: "Alice", phone, nickname: "Ali" }]]) invalid(request("contacts", { contacts }))
 invalid(request("contacts", { contacts: [{ name: "Alice", phone }], displayName: "Bad\0Name" }))
 const twenty = Array.from({ length: 20 }, (_, index) => ({ name: `Person ${index}`, phone }))
 assert.equal(build(request("contacts", { contacts: twenty })).content.contacts.contacts.length, 20)
})

test("polls map options to values with default or multiple selectable choices", () => {
 assert.deepEqual(build(request("poll", { poll: { name: "Lunch?", options: ["Pizza", "Pasta"] } })).content,
  { poll: { name: "Lunch?", values: ["Pizza", "Pasta"], selectableCount: 1 } })
 const options = Array.from({ length: 12 }, (_, index) => `Option ${index}`)
 assert.deepEqual(build(request("poll", { poll: { name: "x".repeat(256), options, selectableCount: 12 } })).content.poll.values, options)
})

test("poll validation rejects duplicates, ambiguous counts, oversized options and unsupported fields", () => {
 for (const poll of [null, [], {}, { name: "", options: ["A", "B"] }, { name: "x".repeat(257), options: ["A", "B"] },
  { name: "Choose", options: [] }, { name: "Choose", options: ["A"] }, { name: "Choose", options: ["A", "A"] },
  { name: "Choose", options: [" Yes ", "yes"] }, { name: "Choose", options: ["A", " "] },
  { name: "Choose", options: ["A", 1] }, { name: "Choose", options: ["A", "x".repeat(101)] },
  { name: "Choose", options: Array.from({ length: 13 }, (_, index) => String(index)) },
  { name: "Choose", options: ["A", "B"], secret: true }]) invalid(request("poll", { poll }))
 for (const selectableCount of [0, -1, 3, 1.5, "1", null, NaN, Infinity]) {
  invalid(request("poll", { poll: { name: "Choose", options: ["A", "B"], selectableCount } }))
 }
})

test("all user-facing strings reject malformed Unicode and unsafe controls while text keeps normal line breaks", () => {
 const unsafe = ["bad\u0000text", "bad\u0008text", "bad\u000btext", "bad\u001ftext", "bad\u007ftext", "bad\u0085text", "bad\u009ftext", "bad\ud800text", "bad\udc00text"]
 for (const value of unsafe) {
  invalid({ phone, message: value })
  invalid(request("image", { url: "https://example.com/p.jpg", caption: value }))
  invalid(request("contacts", { contacts: [{ name: value, phone }] }))
 }
 const text = "Hello 😀\tteam\r\nनमस्ते\nمرحبا"
 assert.equal(build({ phone, message: text }).content.text, text)
 assert.equal(build(request("image", { url: "https://example.com/p.jpg", caption: text })).content.caption, text)
 for (const name of ["Alice\tTeam", "Alice\rTeam", "Alice\nTeam"]) {
  invalid(request("contacts", { contacts: [{ name, phone }] }))
 }
})

test("required strings reject invisible-only content without rewriting valid content", () => {
 for (const invisible of ["\u200b", " \u200c\u200d\ufeff\u2060\ufe0f ", "\u00ad"]) {
  invalid({ phone, message: invisible })
  invalid(request("contacts", { contacts: [{ name: invisible, phone }] }))
  invalid(request("poll", { poll: { name: "Choose", options: ["A", invisible] } }))
 }
 const message = " \u200dHello 👩‍💻\u200b "
 assert.equal(build({ phone, message }).content.text, message)
 assert.equal(build(request("image", { url: "https://example.com/p.jpg", caption: "" })).content.caption, "")
})

test("media URLs reject normalization ambiguities, fragments, nonstandard ports and canonical expansion", () => {
 for (const url of ["https://example.com\\p.jpg", "https://example.com/p\u0000.jpg", "https://example.com/p\u0085.jpg",
  "https://example.com/p.jpg#download", "https://example.com/p.jpg#", "https://example.com:8443/p.jpg", "http://example.com:443/p.jpg",
  `https://example.com/${"é".repeat(400)}.jpg`]) {
  invalid(request("image", { url }))
 }
 assert.equal(build(request("image", { url: "https://example.com:443/photo.jpg" })).media.url, "https://example.com/photo.jpg")
 assert.equal(build(request("image", { url: "http://example.com:80/photo.jpg" })).media.url, "http://example.com/photo.jpg")
 assert.equal(build(request("image", { url: "https://example.com/p%23x.jpg" })).media.url, "https://example.com/p%23x.jpg")
})

test("media MIME metadata normalizes aliases and parameters, rejecting duplicates and unsupported formats", () => {
 assert.equal(build(request("image", { url: "https://example.com/photo", mimetype: " IMAGE/JPG " })).content.mimetype, "image/jpeg")
 assert.equal(build(request("voice", { url: "https://example.com/voice", mimetype: 'Audio/OGG ; codecs = "OPUS"' })).content.mimetype, "audio/ogg; codecs=opus")
 assert.equal(build(request("document", { url: "https://example.com/doc", mimetype: 'text/plain ; charset="UTF-8"' })).content.mimetype, "text/plain; charset=utf-8")
 for (const mimetype of ["audio/ogg; codecs=opus; CODECS=vorbis", "audio/ogg; codecs=opus; codecs=opus", "audio/ogg; codecs=vorbis", "audio/ogg; codecs=\"opus,vorbis\""]) {
  invalid(request("voice", { url: "https://example.com/voice", mimetype }))
 }
 for (const [type, mimetype] of [["image", "image/gif"], ["image", "image/avif"], ["video", "video/webm"], ["audio", "audio/flac"]]) {
  invalid(request(type, { url: "https://example.com/file", mimetype }))
 }
 invalid(request("document", { url: "https://example.com/doc", mimetype: "text/plain; charset=utf-8; CHARSET=ascii" }))
})

test("contact email validation rejects broken local parts and domain labels without network checks", () => {
 for (const email of ["a..b@example.com", ".alice@example.com", "alice.@example.com", "alice@example..com", "alice@-example.com",
  "alice@example-.com", "alice@exam_ple.com", "alice@localhost", `${"a".repeat(65)}@example.com`, `alice@${"a".repeat(64)}.com`, "alice@@example.com"]) {
  invalid(request("contacts", { contacts: [{ name: "Alice", phone, email }] }))
 }
 for (const email of ["alice+team@example.co.in", "a.b@example-domain.com", "o'connor@example.com", "alice@xn--bcher-kva.example"]) {
  const card = build(request("contacts", { contacts: [{ name: "Alice", phone, email }] })).content.contacts.contacts[0].vcard
  assert.ok(card.includes(`EMAIL;TYPE=INTERNET:${email}`))
 }
})

test("canonically equivalent poll choices are duplicates, and distinct choices preserve their original text", () => {
 invalid(request("poll", { poll: { name: "Choose", options: ["Café", " Cafe\u0301 "] } }))
 const values = [" Cafe\u0301 ", "Tea 🍵"]
 assert.deepEqual(build(request("poll", { poll: { name: "Choose", options: values } })).content.poll.values, values)
})
