# Message API usage

This is the usage reference for the implemented message endpoint. The
[README](../README.md) covers installation, QR pairing, and server operation.
The [Postman collection](../postman/Baileys-WhatsApp.postman_collection.json)
contains importable examples. All examples use placeholder recipients, API
keys, and media URLs; replace them before sending.

## Contents

- [Connect and make your first request](#connect-and-make-your-first-request)
- [Request types](#request-types)
- [Field reference](#field-reference)
- [JSON examples for every type](#json-examples)
- [Use Postman](#use-postman)
- [Upload a file](#upload-a-file-from-postman)
- [Call from another service](#call-from-another-service)
- [Limits and resource handling](#limits-and-resource-handling)
- [Responses and errors](#responses)
- [Troubleshooting](#troubleshooting)
- [Keep this reference current](#keep-this-reference-current)

## Connect and make your first request

The default base URL is `http://localhost:3000`. When calling from another
machine, use the reachable URL of the server instead. `localhost` refers to
the machine making the request. Run the server and link its WhatsApp account
using the [pairing instructions](../README.md#pair-from-a-browser-or-another-service).

| Endpoint | Authentication | Purpose |
| --- | --- | --- |
| `GET /ping` | None | Readiness: `200` when WhatsApp is connected, otherwise `503` |
| `GET /qr` | Public page; enter key in page | Open the pairing interface |
| `POST /qr` | `x-api-key` | Request a pairing payload; see README for its body/response |
| `GET /qr/status` | `x-api-key` | Read current pairing status |
| `POST /api/send` | `x-api-key` | Send one message to one phone number |

Check readiness first:

```powershell
curl.exe --request GET "http://localhost:3000/ping"
```

A ready response contains `"status": "ready"` and
`"whatsapp": { "connected": true, ... }`. Then send a JSON request:

```http
POST /api/send HTTP/1.1
Host: localhost:3000
x-api-key: YOUR_API_KEY
Content-Type: application/json

{
  "phone": "12025550123",
  "message": "Hello from the server"
}
```

Use the configured static key from `config/apiKey.js`, or the `API_KEY`
environment override if one was set when the server started. `YOUR_API_KEY`
is a placeholder. Use an `x-api-key` header; query parameters, bearer tokens,
and JSON body fields do not authenticate requests.

All message types use **`POST /api/send`** with the same `x-api-key` header.
The recipient is always a string `phone` containing the full country code.
The existing `{ "phone": "...", "message": "..." }` text request still works.

For JSON requests, set `Content-Type: application/json`. For file uploads,
use multipart form data and let Postman or your HTTP client generate the
`Content-Type` boundary. Sending through GET remains disabled.

## Request types

| `type` | Required content | Optional fields |
| --- | --- | --- |
| `text` (default) | `message` | None |
| `image` | `url` or uploaded `file` | `caption`, `mimetype`, `viewOnce` |
| `video` | `url` or uploaded `file` | `caption`, `mimetype`, `gifPlayback`, `viewOnce` |
| `audio` | `url` or uploaded `file` | `mimetype`, `ptt`, `seconds`, `viewOnce` |
| `voice` | `url` or uploaded `file` | `mimetype`, `seconds`, `viewOnce` |
| `document` | `url` or uploaded `file` | `caption`, `mimetype`, `fileName` |
| `sticker` | `url` or uploaded `file` | `mimetype`, `isAnimated` |
| `location` | `location.latitude`, `location.longitude` | `location.name`, `location.address` |
| `contacts` | `contacts[]` with `name` and `phone` | `displayName`; each contact's `organization`, `email` |
| `poll` | `poll.name`, `poll.options[]` | `poll.selectableCount` |

Use exactly one content type and one media source in each request. Unknown or
irrelevant fields return `400`, so mistakes such as a caption on a voice note
are visible. JSON booleans and numbers must use their actual JSON types.
Optional `false` and `0` values are preserved.

Requests contain one JSON object, not an array of messages. Type names and
field names are case-sensitive. Omit optional fields you do not need rather
than setting them to `null`. A request with `type` omitted is treated as text,
so always provide `type` for media, locations, contacts, and polls.

## Field reference

String length limits below use JavaScript string code units; some emoji count
as more than one unit. File sizes and multipart field limits use bytes.

### Common fields

| Field | JSON type | Required | Rules |
| --- | --- | --- | --- |
| `phone` | String | Always | Full international phone number with country code; 7 to 15 digits after formatting is removed; first digit cannot be `0` |
| `type` | String | Except legacy text | One of the exact lowercase values in the request-type table; defaults to `text` |
| `message` | String | Text only | Nonblank, at most 4096 code units; original spacing and line breaks are preserved |

`"12025550123"` and `"+1 (202) 555-0123"` address the same recipient. A leading
`+`, whitespace, parentheses, and hyphens are allowed. Send the value as a
string, never a JSON number. Local numbers without a country code, leading
`00`, letters, arrays of recipients, group identifiers, and WhatsApp JIDs
such as `12025550123@s.whatsapp.net` are not supported. Validation checks the
number's shape; it does not check whether the recipient has WhatsApp.

### Media sources and optional fields

Every media request requires exactly one source: `url` in JSON, or a file
part named `file` in multipart form data. `file` is not a JSON field. Do not
send both sources. Empty media files are rejected.

| Field | JSON type | Applies to | Behavior and limits |
| --- | --- | --- | --- |
| `url` | String | All media | Absolute public HTTP/HTTPS direct file URL; at most 2048 code units; no whitespace or embedded credentials |
| `mimetype` | String | All media | Optional MIME type, at most 200 code units; usually omit it and let content detection choose |
| `caption` | String | Image, video, document | Optional, at most 1024 code units; an empty string is allowed |
| `viewOnce` | Boolean | Image, video, audio, voice | `true` requests view-once delivery; omitted means the flag is not supplied |
| `gifPlayback` | Boolean | Video | `true` requests GIF-style playback of the supplied MP4; omit for ordinary video |
| `ptt` | Boolean | Audio | `true` requests a voice note and requires Ogg/Opus content; omit for ordinary audio; `type: "voice"` sets it automatically |
| `seconds` | Number | Audio, voice | Optional duration metadata from `0` through `86400`, including fractional values |
| `fileName` | String | Document | Optional recipient-visible filename, at most 255 code units; no directory separators or control characters; cannot be `.` or `..` |
| `isAnimated` | Boolean | Sticker | Describes the supplied WebP; omit unless needed; no animation or conversion is performed |

For image, video, audio, voice, and sticker, an explicit `mimetype` must match
the detected file type or the server returns `415`. For documents, the
detected type wins; the MIME hint is used only when detection is unavailable.
When no MIME hint is given, the server initially uses upload metadata, a known
filename extension, or a type-specific fallback, then checks actual content.
Supplying an incompatible category, such as `image/jpeg` for a video, returns
`400` during validation.

Document `fileName` defaults to the uploaded filename or decoded URL basename,
then to `document` if neither is available. URL query parameters do not set
the filename. Supply `fileName` for download URLs whose basename is not the
filename you want the recipient to see.

### Location fields

These fields belong inside the `location` object.

| Field | JSON type | Required | Rules |
| --- | --- | --- | --- |
| `latitude` | Number | Yes | Finite number from `-90` through `90` |
| `longitude` | Number | Yes | Finite number from `-180` through `180` |
| `name` | String | No | Nonblank, at most 256 code units, no control characters |
| `address` | String | No | Nonblank, at most 1024 code units, no control characters |

Coordinates must be JSON numbers, such as `22.5726`, not strings such as
`"22.5726"`. Zero is a valid coordinate.

### Contact fields

`contacts` must be an array containing 1 to 20 objects. The request's `phone`
is the recipient; each contact's `phone` is the number stored in that card.

| Field | JSON type | Required | Rules |
| --- | --- | --- | --- |
| `contacts[].name` | String | Yes | Nonblank, at most 256 code units, no control characters |
| `contacts[].phone` | String | Yes | Same international phone-format rules as the recipient |
| `contacts[].organization` | String | No | Nonblank, at most 256 code units, no control characters |
| `contacts[].email` | String | No | Valid email address, at most 254 code units, no control characters |
| `displayName` | String | No | Top-level label for multiple cards; nonblank, at most 256 code units, no control characters |

The server generates the vCard content. Do not pass raw `vcard` fields. With
one card, its contact name is shown. With multiple cards, the label defaults
to `N contacts` unless you supply `displayName`.

### Poll fields

These fields belong inside the `poll` object.

| Field | JSON type | Required | Rules |
| --- | --- | --- | --- |
| `name` | String | Yes | Nonblank question, at most 256 code units, no control characters |
| `options` | Array of strings | Yes | 2 to 12 nonblank options; each at most 100 code units; no control characters |
| `selectableCount` | Integer | No | Defaults to `1`; from `1` through the number of options |

Options must be distinct after surrounding whitespace is removed and case
is ignored: `"Morning"` and `" morning "` are duplicates. Their original
text is preserved in the outgoing poll. To allow choosing every option, set
`selectableCount` to the option count; `0` is rejected.

## JSON examples

Replace the example number with the recipient's number and the example media
URLs with actual public file URLs. Example URLs are placeholders.

### Text

```json
{
  "phone": "12025550123",
  "message": "Hello from the server"
}
```

### Image

```json
{
  "phone": "12025550123",
  "type": "image",
  "url": "https://example.com/photo.jpg",
  "caption": "Here is the photo"
}
```

An optional `viewOnce: true` requests view-once delivery. JPEG, PNG, and WebP
are accepted image formats; the server checks the file content.

### Video

```json
{
  "phone": "12025550123",
  "type": "video",
  "url": "https://example.com/clip.mp4",
  "caption": "Here is the video",
  "gifPlayback": false
}
```

Use an MP4 file with codecs supported by WhatsApp. `gifPlayback: true` requests
GIF-style playback of a suitable MP4; it does not convert a GIF file.

### Audio

```json
{
  "phone": "12025550123",
  "type": "audio",
  "url": "https://example.com/audio.mp3"
}
```

Detected MP3, Ogg/Opus, supported Ogg audio, M4A/MP4 audio, AAC, and WAV files
are accepted. Optional `seconds` supplies duration metadata and avoids Baileys
calculating it; it must be a number from `0` to `86400`. This metadata does not
change the recording. Actual playback still depends on the file's codecs.

### Voice note

```json
{
  "phone": "12025550123",
  "type": "voice",
  "url": "https://example.com/voice.opus",
  "seconds": 12
}
```

Voice notes require actual **Ogg/Opus** content. `type: "voice"` sets `ptt: true`
and the appropriate MIME type. `type: "audio", "ptt": true` is another way to
request the same voice-note behavior. The server verifies the detected format;
changing a filename or MIME field does not convert MP3 to Opus. Upload or host
a correctly encoded recording. Automatic transcoding is not performed.

The equivalent audio request is:

```json
{
  "phone": "12025550123",
  "type": "audio",
  "url": "https://example.com/voice.opus",
  "ptt": true,
  "seconds": 12
}
```

For `type: "voice"`, omit the `ptt` field; it is set automatically and is not
an accepted request field for that type.

### Document

```json
{
  "phone": "12025550123",
  "type": "document",
  "url": "https://example.com/invoice.pdf",
  "fileName": "invoice.pdf",
  "caption": "Your invoice"
}
```

`fileName` is optional: it falls back to the uploaded filename or URL basename.
`mimetype` is optional; detected content takes precedence, with supplied or
inferred metadata used where detection is unavailable. A generic document uses
`application/octet-stream` when its type is unknown. HTML pages returned by a
media URL are rejected to avoid sending an error/login page as a document.

### Sticker

```json
{
  "phone": "12025550123",
  "type": "sticker",
  "url": "https://example.com/sticker.webp",
  "isAnimated": false
}
```

Supply a WhatsApp-compatible WebP sticker. `isAnimated` describes the supplied
file; it does not animate or convert an image.

### Static location

```json
{
  "phone": "12025550123",
  "type": "location",
  "location": {
    "latitude": 22.5726,
    "longitude": 88.3639,
    "name": "Meeting point",
    "address": "Kolkata, India"
  }
}
```

Latitude must be between `-90` and `90`; longitude between `-180` and `180`.
This sends one static map pin, not a live-location stream.

### Contact cards

```json
{
  "phone": "12025550123",
  "type": "contacts",
  "contacts": [
    {
      "name": "Alex Example",
      "phone": "12025550124",
      "organization": "Example Company",
      "email": "alex@example.com"
    }
  ]
}
```

Send between 1 and 20 contacts. The server validates their phone numbers and
generates escaped vCard 3.0 records. For multiple cards, an optional top-level
`displayName` provides a collection label; otherwise a label is generated.

Example with two cards:

```json
{
  "phone": "12025550123",
  "type": "contacts",
  "displayName": "Support team",
  "contacts": [
    { "name": "Alex Example", "phone": "12025550124" },
    { "name": "Sam Example", "phone": "12025550125" }
  ]
}
```

### Poll

```json
{
  "phone": "12025550123",
  "type": "poll",
  "poll": {
    "name": "Which time works for you?",
    "options": ["Morning", "Afternoon", "Evening"],
    "selectableCount": 1
  }
}
```

Polls require 2 to 12 distinct, nonblank options. `selectableCount` defaults to
`1`; set it between `1` and the number of options to permit multiple choices.
For the three-option example, `selectableCount: 2` permits up to two choices,
and `selectableCount: 3` permits all three choices.
This endpoint sends the poll. Persistent vote collection and result-query APIs
are separate features and are not implemented by this change.

## Use Postman

1. Import
   [`Baileys-WhatsApp.postman_collection.json`](../postman/Baileys-WhatsApp.postman_collection.json).
2. Open the collection's **Variables** tab and set:

   | Variable | Value |
   | --- | --- |
   | `baseUrl` | The running server URL, such as `http://localhost:3000`, without a trailing `/` |
   | `apiKey` | The server's configured static API key |
   | `phone` | The recipient's international number as text, such as `12025550123` |

3. Open the request for the message type you want. JSON requests already use
   **Body > raw > JSON**, the `x-api-key` header, and `Content-Type: application/json`.
4. Replace every placeholder media URL in that request with a reachable direct
   file URL. For contact cards, edit the card's own phone number separately;
   the `phone` collection variable controls the recipient.
5. Choose **Send** and check both the HTTP status and response body. A successful
   send returns `200` and `success: true`.

For a new request created manually, choose `POST`, set the URL to
`{{baseUrl}}/api/send`, add the same headers, and paste a JSON example above.
Postman sends the API key through the header; do not use its Bearer Token tab
for this server.

## Upload a file from Postman

1. Set the method to `POST` and URL to `{{baseUrl}}/api/send`.
2. Add the `x-api-key` header.
3. Choose **Body > form-data**.
4. Add `phone` and `type` as Text fields.
5. Add `file`, change its field type to **File**, and select the file.
6. Add only the optional fields applicable to that type, such as `caption`.
7. Let Postman generate the multipart Content-Type header; remove a manually
   added `Content-Type: application/json` header for this request.

For example:

| Field | Postman kind | Value |
| --- | --- | --- |
| `phone` | Text | `12025550123` |
| `type` | Text | `image` |
| `file` | File | Select `photo.png` |
| `caption` | Text | `Uploaded from Postman` |
| `viewOnce` | Text | `false` |

Multipart boolean fields accept the exact strings `true` or `false`. Numeric
duration fields accept a numeric string. The server streams uploads into its
own temporary directory and removes the files after success, errors, or
cancellation. One uploaded file is supported per request. Locations, contacts,
polls, and text should use JSON.

Use these file types and fields when adapting the upload request:

| `type` text value | File to select | Optional text fields |
| --- | --- | --- |
| `image` | JPEG, PNG, or WebP | `caption`, `mimetype`, `viewOnce` |
| `video` | MP4 | `caption`, `mimetype`, `gifPlayback`, `viewOnce` |
| `audio` | MP3, supported Ogg, M4A/MP4 audio, AAC, or WAV | `mimetype`, `ptt`, `seconds`, `viewOnce` |
| `voice` | Ogg/Opus | `mimetype`, `seconds`, `viewOnce` |
| `document` | The document to attach | `caption`, `mimetype`, `fileName` |
| `sticker` | WhatsApp-compatible WebP | `mimetype`, `isAnimated` |

When changing the collection's **Image file upload** request to another type,
delete or uncheck optional rows that do not apply. For example, an audio or
voice request must remove `caption`; a document request must remove
`viewOnce`; a sticker request must remove both. Changing only `type` leaves
incompatible fields and returns `400`.

Each multipart request supports at most 16 text fields, each at most 8 KiB,
with at most 32 KiB combined field-name and value bytes. Field names must be
at most 100 bytes. Do not repeat a field name or upload more than one file.
The file can appear before or after the text fields. Multipart duration
strings use digits and an optional decimal fraction, such as `"12"` or
`"12.5"`; booleans must be exactly lowercase `"true"` or `"false"`.

An importable [Postman collection](../postman/Baileys-WhatsApp.postman_collection.json)
includes every type and a file-upload example. Set its `baseUrl`, `apiKey`, and
`phone` variables, then replace placeholder URLs or select an uploaded file.

## Call from another service

Use the same endpoint and payloads from your interface's backend. Cross-origin
browser requests need a backend proxy with the current server configuration;
CORS is not enabled. Set your backend's base URL to the reachable server URL,
not its own `localhost`, when the two run on different machines.

### cURL

For any JSON example above, save the object as UTF-8 `request.json` in the
current directory, replace its placeholder values, then run:

```powershell
curl.exe --request POST "http://localhost:3000/api/send" --header "x-api-key: YOUR_API_KEY" --header "Content-Type: application/json" --data-binary "@request.json"
```

The examples use `curl.exe` for Windows PowerShell. On Linux or macOS, use
`curl` with the same arguments. The `@request.json` syntax reads the body from
the file and avoids shell quoting problems.

To upload a local image:

```powershell
curl.exe --request POST "http://localhost:3000/api/send" --header "x-api-key: YOUR_API_KEY" --form "phone=12025550123" --form "type=image" --form "file=@./photo.png" --form "caption=Uploaded photo" --form "viewOnce=false"
```

To upload a prepared voice note:

```powershell
curl.exe --request POST "http://localhost:3000/api/send" --header "x-api-key: YOUR_API_KEY" --form "phone=12025550123" --form "type=voice" --form "file=@./voice.opus" --form "seconds=12"
```

To upload a document with a recipient-visible filename:

```powershell
curl.exe --request POST "http://localhost:3000/api/send" --header "x-api-key: YOUR_API_KEY" --form "phone=12025550123" --form "type=document" --form "file=@./invoice.pdf" --form "fileName=invoice.pdf" --form "caption=Your invoice"
```

The path following `@` is on the client running cURL. The HTTP API itself
does not accept a server filesystem path. Keep the multipart Content-Type
unset so cURL generates its boundary.

### PowerShell JSON request

```powershell
$baseUrl = "http://localhost:3000"
$apiKey = "YOUR_API_KEY"
$payload = @{
  phone = "12025550123"
  type = "image"
  url = "https://example.com/photo.jpg"
  caption = "Photo from PowerShell"
  viewOnce = $false
}

$requestOptions = @{
  Method = "Post"
  Uri = "$baseUrl/api/send"
  Headers = @{ "x-api-key" = $apiKey }
  ContentType = "application/json"
  Body = ($payload | ConvertTo-Json -Depth 6)
}
Invoke-RestMethod @requestOptions
```

Replace `$payload` with the fields for any other JSON message type. Keep the
serialization depth for nested `location`, `contacts`, and `poll` objects.

### JavaScript backend

This Node.js example reads the server URL and API key from the calling
service's configuration:

```javascript
async function sendWhatsApp(payload) {
  const baseUrl = process.env.WHATSAPP_SERVER_URL.replace(/\/+$/, "")
  const response = await fetch(`${baseUrl}/api/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.WHATSAPP_API_KEY
    },
    body: JSON.stringify(payload)
  })
  const result = await response.json()
  if (!response.ok) {
    const error = new Error(result.error || `WhatsApp API returned ${response.status}`)
    error.status = response.status
    throw error
  }
  return result
}

const result = await sendWhatsApp({
  phone: "12025550123",
  type: "poll",
  poll: {
    name: "Which time works for you?",
    options: ["Morning", "Afternoon", "Evening"],
    selectableCount: 1
  }
})
console.log(result.messageId)
```

Set `WHATSAPP_SERVER_URL` and `WHATSAPP_API_KEY` in that calling service; these
names belong to the example client. The WhatsApp server's own key override
is named `API_KEY`. A fetch/network exception means no reliable HTTP response
was received; it does not establish whether a send already took place.

## Limits and resource handling

These are server limits, not a promise about WhatsApp's limits or codecs.

| Media type | Maximum file size |
| --- | ---: |
| Image | 10 MiB |
| Video | 50 MiB |
| Audio / voice | 16 MiB |
| Document | 100 MiB |
| Sticker | 1 MiB |

One MiB is `1,048,576` bytes. Files must be nonempty. A valid file at exactly
the applicable limit is allowed; larger files return `413`.

- JSON metadata retains the 32 KiB request limit. Media bytes belong in a URL
  resource or multipart file; base64 JSON and server filesystem paths are not
  accepted.
- URLs must be public HTTP/HTTPS resources on standard ports. Each redirect
  and DNS answer is checked; loopback, private, local, and reserved destinations
  are rejected. No API key is forwarded to the media host.
- Remote media is streamed with backpressure and a byte cap. Downloads have a
  10-second DNS/connection/header deadline per hop and a 60-second total deadline;
  at most three redirects are followed.
- File signatures are inspected using a small bounded prefix. MIME labels and
  extensions alone do not make incompatible bytes valid media.
- Captions are at most 1024 characters; text messages remain limited to 4096.
  Poll names are at most 256 characters and each option at most 100.
- A media request has a 60-second WhatsApp upload timeout. Sending is never
  automatically retried, avoiding an accidental duplicate after an uncertain
  failure.

Direct URLs must return a final HTTP `200` response containing the file.
HTTP URLs use port `80` and HTTPS URLs port `443`. Share/login/preview pages,
`file:` URLs, `data:` URLs, `localhost`, private LAN addresses, and nonstandard
ports are not accepted media sources. A local image can still be supplied as
a multipart upload. The remote server must return uncompressed content
(`Content-Encoding` absent or `identity`); gzip and other HTTP encodings are
rejected. A PDF or ZIP file itself is fine; this restriction concerns HTTP
transfer encoding.

The server does not forward authentication headers or cookies to the media
host, and there is no request option for custom download headers. A public
file URL or a signed URL that is valid when fetched can be used. Keep signed
URLs within the 2048-code-unit limit and valid long enough to complete the
download. The source URL's query string is used when retrieving the file.

File detection checks signatures; it does not transcode video/audio, resize
images, generate sticker files, or guarantee that every detected codec will
play on every client. Prepare a compatible file before calling the endpoint.
Allow time for both media preparation and the WhatsApp upload when configuring
timeouts in your client or reverse proxy; the 60-second upload timeout is not
a deadline for the entire HTTP request.

## Responses

All types preserve the existing successful response shape:

```json
{
  "success": true,
  "phone": "12025550123",
  "messageId": "BAILEYS_MESSAGE_ID"
}
```

Success means the Baileys send operation completed, not that the recipient
delivered/read the message. The `messageId` is omitted if Baileys returns none.

| Response field | Type | Meaning |
| --- | --- | --- |
| `success` | Boolean | `true` for a completed send, `false` for an API error |
| `phone` | String | On success, the original phone string from the request, including any formatting |
| `messageId` | String, optional | On success, the ID returned by Baileys, when available |
| `error` | String | On failure, a description of the problem |

For example, sending with `"phone": "+1 (202) 555-0123"` returns that same
formatted string in `phone`; normalization is used internally for delivery.
There are no delivery/read receipt or message-status-query endpoints in this
implementation. Responses are marked `Cache-Control: no-store`.

An error response has this shape:

```json
{
  "success": false,
  "error": "WhatsApp is not connected"
}
```

| Status | Meaning |
| --- | --- |
| `400` | Invalid request, incompatible options, or invalid media source |
| `401` | Missing or incorrect API key |
| `404` | URL does not match an endpoint |
| `405` | Sending attempted with a method other than POST |
| `413` | Request/upload/media exceeds a server limit |
| `415` | Unsupported upload encoding or media format |
| `502` | Media retrieval or WhatsApp send failed |
| `503` | WhatsApp is not connected |
| `504` | Media retrieval timed out |
| `500` | Unexpected server failure |

With the correct key, `GET`, `PUT`, `PATCH`, `DELETE`, and other unsupported
methods on `/api/send` return `405` with `Allow: POST`. Without a valid key,
authentication runs first and the request returns `401`.

### Error examples and retry behavior

| HTTP status | Example `error` | What to do |
| --- | --- | --- |
| `400` | `Unexpected request field: caption` | Remove the field if it does not apply to the selected type |
| `400` | `Provide exactly one media source: url or multipart file` | Supply either a URL or one file, never both |
| `400` | `Invalid JSON body` | Correct JSON syntax and use the JSON Content-Type |
| `401` | `Invalid or missing API key` | Set the configured key in `x-api-key` |
| `413` | `Media file exceeds the size limit` | Reduce file size and check the selected type's limit |
| `415` | `Voice notes require an Ogg/Opus audio file` | Supply a correctly encoded Opus recording |
| `415` | `The media URL returned an HTML page instead of a file` | Use a direct file URL or multipart upload |
| `502` | `Media server did not return a downloadable file` | Check that the source URL returns HTTP `200` without login |
| `502` | `Failed to send WhatsApp message` | Check connection/server logs and whether the message already arrived before retrying |
| `503` | `WhatsApp is not connected` | Check `/ping`, pair if needed, and retry once ready |
| `504` | `Media download timed out` | Check the media host or upload the file directly |

Use the HTTP status to classify failures and the message for diagnosis; do
not depend on error text as a permanent machine-readable error code. Read
the response body even when the HTTP status is not `200`.

Validation, authentication, readiness, and media-preparation failures happen
before a send. A generic send failure or a client/proxy timeout can leave the
outcome uncertain: WhatsApp might already have accepted the message. The API
does not implement idempotency keys, duplicate suppression, or automatic
resending. Avoid blind retries after an uncertain outcome; check the linked
account and record successful `messageId` values in your calling service.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Connection refused or no HTTP response | The Node server is running; base URL, port, firewall, and proxy are correct |
| `/ping` returns `503` | Inspect `whatsapp.state`, then use `/qr` if pairing is needed |
| Every send returns `401` | Replace `YOUR_API_KEY`/`{{apiKey}}` and check for an active `API_KEY` override on the server |
| JSON returns `400` | Use **raw > JSON**, keep `phone` as a string, use numbers/booleans with their actual JSON types, and remove irrelevant fields |
| Postman upload says file missing | Use **form-data**, change `file` from Text to File, and select a nonempty file |
| Upload fails after changing its type | Remove incompatible optional fields from the original image upload template |
| Multipart request says boundary missing | Remove the manually entered Content-Type header; let the client generate it |
| Public media URL fails | Open its direct download URL without cookies; check its status, file type, port, size, and HTTP encoding |
| Localhost or LAN media URL is rejected | Use a multipart file upload or a public media host |
| Voice/sticker format is rejected | Supply actual Ogg/Opus or WebP bytes; renaming a file does not convert it |
| Browser reports CORS failure | Call through the interface backend with this testing server configuration |
| API returned `200` but no read receipt | `200` confirms the Baileys send call; this API does not report recipient delivery/read events |

## Keep this reference current

Treat this file as the usage reference for `/api/send`. When changing a
request field, supported format, limit, or response:

1. Update the corresponding field table, example, and error guidance here.
2. Update the [Postman collection](../postman/Baileys-WhatsApp.postman_collection.json)
   and the [README](../README.md) if its overview changes.
3. Check the examples against the payload validation in
   [messagePayload.js](../utils/messagePayload.js), format/download behavior in
   [mediaSource.js](../services/mediaSource.js), and multipart behavior in
   [mediaUpload.js](../middleware/mediaUpload.js).
4. Run the relevant existing checks, including
   `node --test test/sendTypes.test.js test/messagePayload.test.js` for payload
   or collection changes. These use fake sockets and offline fixtures.
