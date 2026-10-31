# Message API usage

This is the usage reference for the implemented message endpoint. The
[README](../README.md) covers installation, QR pairing, and server operation.
The [Postman collection](../postman/Baileys-WhatsApp.postman_collection.json)
contains importable examples. All examples use placeholder recipients, API
keys, and media URLs; replace them before sending.
The default send response is now HTTP `202` with a job ID; execution and
delivery status are checked separately. The [queue guide](QUEUE.md) covers
configuration, operations, and crash limitations. The
[Cloudflare plan](CLOUDFLARE_INTEGRATION.md) covers future durable coordination.

## Contents

- [Connect and make your first request](#connect-and-make-your-first-request)
- [Track queued messages](#track-queued-messages)
- [Migrate an existing synchronous caller](#migrate-an-existing-synchronous-caller)
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
| `GET /live` | None | Process liveness: `200` while HTTP can respond |
| `GET /ready` | None | Worker, queue capacity, and WhatsApp readiness: `200` ready, otherwise `503` |
| `GET /ping` | None | Readiness: `200` when WhatsApp is connected, otherwise `503` |
| `GET /qr` | Public page; enter key in page | Open the pairing interface |
| `POST /qr` | `x-api-key` | Request a pairing payload; see README for its body/response |
| `GET /qr/status` | `x-api-key` | Read current pairing status |
| `POST /api/send` | `x-api-key` | Validate and accept one message job for one phone number |
| `GET /api/messages/:jobId` | `x-api-key` | Read one retained job's execution/delivery status |
| `GET /api/queue/stats` | `x-api-key` | Inspect queue and staging metrics |

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

Only `wait=true` or `wait=false` is supported as an optional query parameter
on `/api/send`. Do not put the phone, message, type, or API key in its query
string. Status and queue-statistics requests accept no query parameters.

## Track queued messages

A valid request normally returns HTTP `202 Accepted` after all validation and
any complete media staging finish:

```json
{
  "success": true,
  "jobId": "5ed5825f-09ab-45a5-b75d-48cc933b0234",
  "status": "queued",
  "statusUrl": "/api/messages/5ed5825f-09ab-45a5-b75d-48cc933b0234"
}
```

The `Location` response header contains the same status path. Save `jobId`
and use that path with the same API key:

```powershell
curl.exe --request GET "http://localhost:3000/api/messages/5ed5825f-09ab-45a5-b75d-48cc933b0234" --header "x-api-key: YOUR_API_KEY"
```

Example status after the send completes:

```json
{
  "success": true,
  "job": {
    "jobId": "5ed5825f-09ab-45a5-b75d-48cc933b0234",
    "sessionId": "default",
    "status": "sent",
    "attempts": 1,
    "createdAt": "2026-10-31T08:00:00.000Z",
    "updatedAt": "2026-10-31T08:00:01.000Z",
    "startedAt": "2026-10-31T08:00:00.000Z",
    "completedAt": "2026-10-31T08:00:01.000Z",
    "sentAt": "2026-10-31T08:00:01.000Z",
    "messageId": "EXAMPLE_WHATSAPP_MESSAGE_ID"
  }
}
```

Normal progression is `queued -> processing -> sent -> delivered -> read`.
Safe pre-send failures may enter `retry_wait`; permanent errors become
`failed`, unstarted shutdown work becomes `cancelled`, and ambiguous send
results become `unknown`. A delayed retry blocks later jobs in the same
session. Duplicate/out-of-order acknowledgements cannot reverse delivery
progress. Missing acknowledgements leave the last known state unchanged.

`sent` confirms a send result, not recipient delivery. Only a reliable
acknowledgement advances it to `delivered` or `read`; availability depends on
WhatsApp and recipient settings. A late reliable acknowledgement can resolve
`unknown`. Never resend an unknown job automatically.

Job snapshots omit recipients and content. Optional fields include
`nextAttemptAt`, `deliveredAt`, `readAt`, and a sanitized
`error: { "code": "JOB_EXPIRED", "retryable": false }`. `attempts` counts
processing attempts; one may stop before any WhatsApp call. Timestamps use UTC
ISO strings; `startedAt`/`completedAt` are initially `null`.

Jobs and statuses are in memory. Completed statuses are retained for at most
one hour and 1000 records by default. Expired, evicted, or unknown IDs return
`404`; this does not establish that a send never happened. A restart loses
all local jobs and status records. See [crash behavior](QUEUE.md#graceful-shutdown-and-crash-behavior).

## Migrate an existing synchronous caller

The request fields are unchanged. Replace code that expects an immediate
`messageId` with code that stores `jobId` from HTTP `202` and checks status.
An accepted job keeps running after its HTTP response. Do not repeat
`POST /api/send` to poll, after a wait timeout, or because delivery is pending.

For a temporary migration, append `?wait=true` or configure
`QUEUE_API_MODE=wait`. The default wait limit is 25 seconds
(`QUEUE_HTTP_WAIT_MS`). `?wait=false` overrides that mode for one request.
A known completed send returns HTTP `200`:

```json
{
  "success": true,
  "phone": "12025550123",
  "messageId": "BAILEYS_MESSAGE_ID",
  "jobId": "5ed5825f-09ab-45a5-b75d-48cc933b0234",
  "status": "sent"
}
```

If it is still pending, the response is `202` with the **same job ID** and
current status. Known failure/cancellation returns `503` with its job ID and
status. An ambiguous outcome returns `502`, for example:

```json
{
  "success": false,
  "jobId": "5ed5825f-09ab-45a5-b75d-48cc933b0234",
  "status": "unknown",
  "error": "AMBIGUOUS_SEND_OUTCOME"
}
```

Poll that job and investigate uncertainty rather than creating another send.
If the HTTP connection fails before a response, the request might already
have been accepted. This local API has no durable idempotency-key contract.

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
All strings must contain valid Unicode. NUL, unsafe control characters, and
unpaired surrogates are rejected. Text and captions may contain ordinary
tabs and line breaks; structured fields may not. Required strings cannot
consist only of whitespace or invisible formatting characters.

### Common fields

| Field | JSON type | Required | Rules |
| --- | --- | --- | --- |
| `phone` | String | Always | At most 64 code units including formatting; full country code; 7 to 15 digits after formatting is removed; first digit cannot be `0` |
| `type` | String | Except legacy text | One of the exact lowercase values in the request-type table; defaults to `text` |
| `message` | String | Text only | Nonblank, at most 4096 code units; original spacing and line breaks are preserved |

`"12025550123"` and `"+1 (202) 555-0123"` address the same recipient. A leading
`+`, ordinary ASCII spaces, parentheses, and hyphens are allowed. Tabs, line
breaks, and other Unicode whitespace are rejected. Send the value as a
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
| `url` | String | All media | Absolute public HTTP/HTTPS direct file URL; at most 2048 code units before and after URL normalization; no whitespace, controls, backslashes, fragments, or embedded credentials |
| `mimetype` | String | All media | Optional MIME type, at most 200 code units; usually omit it and let content detection choose |
| `caption` | String | Image, video, document | Optional, at most 1024 code units; an empty string is allowed |
| `viewOnce` | Boolean | Image, video, audio, voice | `true` requests view-once delivery; omitted means the flag is not supplied |
| `gifPlayback` | Boolean | Video | `true` requests GIF-style playback of the supplied MP4; omit for ordinary video |
| `ptt` | Boolean | Audio | `true` requests a voice note and requires Ogg/Opus content; omit for ordinary audio; `type: "voice"` sets it automatically |
| `seconds` | Integer | Audio, voice | Optional whole-second duration metadata from `0` through `86400`; fractional values are rejected |
| `fileName` | String | Document | Optional recipient-visible filename, at most 255 code units; no directory separators or control characters; cannot be `.` or `..` |
| `isAnimated` | Boolean | Sticker | When supplied, must match the actual WebP animation; detected automatically when omitted; no animation or conversion is performed |

An explicit `mimetype` must match the detected file type or the server
returns `415`. For documents, `application/octet-stream` is a permitted
generic hint; other explicit MIME hints must match a recognized format.
If document detection is unavailable, the provided MIME hint is retained.
Legacy Word/Excel/PowerPoint files share a generic container signature; a
compatible explicit Office MIME hint is retained for that container.
When no MIME hint is given, the server initially uses upload metadata, a known
filename extension, or a type-specific fallback, then checks actual content.
Supplying an incompatible category, such as `image/jpeg` for a video, returns
`400` during validation.

Only the formats listed in the examples below are accepted for their media
types. Common aliases such as `image/jpg` and `audio/x-m4a` are normalized.
Duplicate MIME parameters are rejected, and explicit codec metadata must
match the detected codec when the detector reports one.

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
| `contacts[].email` | String | No | ASCII email address with a valid local part and domain labels, at most 254 code units; local part at most 64; no whitespace, controls, leading/trailing dots, or repeated dots |
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
is ignored, including Unicode-equivalent spellings: `"Morning"` and
`" morning "` are duplicates. Their original
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
calculating it; it must be an integer from `0` to `86400`. This metadata does not
change the recording. Actual playback still depends on the file's codecs.
When `seconds` is omitted, the server uses the validated file's duration,
rounded up to a whole second.

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
`mimetype` is optional; detected content is used, with supplied or inferred
metadata used where detection is unavailable. A conflicting explicit MIME
type returns `415`, except for the generic `application/octet-stream` hint.
A generic document uses
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
file and must match its actual animation; it does not animate or convert an
image. Stickers must be at most 512 pixels wide and high.

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
   | `jobId` | Filled automatically after an accepted send; can also be set to a previously saved job ID |

3. Open the request for the message type you want. JSON requests already use
   **Body > raw > JSON**, the `x-api-key` header, and `Content-Type: application/json`.
4. Replace every placeholder media URL in that request with a reachable direct
   file URL. For contact cards, edit the card's own phone number separately;
   the `phone` collection variable controls the recipient.
5. Choose **Send** and check both the HTTP status and response body. Normal
   acceptance returns `202`, `success: true`, and a `jobId`. The collection
   saves that ID automatically.
6. Open the included status request for `GET {{baseUrl}}/api/messages/{{jobId}}`.
   Send it with the same API key and inspect `job.status`. Repeat that GET
   with a reasonable polling delay until a send result or failure is known;
   do not repeat the original POST. The collection also includes liveness,
   readiness, ping, and authenticated queue-statistics requests.

For a new request created manually, choose `POST`, set the URL to
`{{baseUrl}}/api/send`, add the same headers, and paste a JSON example above.
Postman sends the API key through the header; do not use its Bearer Token tab
for this server. Its default response is `202`; use `?wait=true` only if
you need the bounded compatibility wait described above.

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
duration fields accept a digits-only whole-number string. The server streams
the upload to disk, validates it, and transfers it into bounded queue-owned
staging before returning `202`. Request-owned files are then removed; staged
files remain until the job finishes, expires, or is cancelled. Rejected or
interrupted requests clean up their files. One uploaded file is supported per request. Locations, contacts,
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
strings use digits only, such as `"12"`; `"12.5"` is rejected. Booleans must
be exactly lowercase `"true"` or `"false"`. Uploaded filenames must be valid
Unicode, at most 255 code units, and contain no control characters.

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
$accepted = Invoke-RestMethod @requestOptions
$accepted.jobId
Invoke-RestMethod -Method Get -Uri "$baseUrl$($accepted.statusUrl)" -Headers @{ "x-api-key" = $apiKey }
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
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(90000)
  })
  const result = await response.json()
  if (!response.ok) {
    const error = new Error(result.error || `WhatsApp API returned ${response.status}`)
    error.status = response.status
    error.jobId = result.jobId
    throw error
  }
  return result
}

async function checkWhatsAppJob(jobId) {
  const baseUrl = process.env.WHATSAPP_SERVER_URL.replace(/\/+$/, "")
  const response = await fetch(`${baseUrl}/api/messages/${encodeURIComponent(jobId)}`, {
    headers: { "x-api-key": process.env.WHATSAPP_API_KEY },
    signal: AbortSignal.timeout(15000)
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || `Status API returned ${response.status}`)
  return result.job
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
console.log(result.jobId)
for (let poll = 0; poll < 10; poll += 1) {
  const job = await checkWhatsAppJob(result.jobId)
  console.log(job.status)
  if (["sent", "delivered", "read", "failed", "cancelled", "unknown"].includes(job.status)) break
  await new Promise((resolve) => setTimeout(resolve, 1000))
}
```

Set `WHATSAPP_SERVER_URL` and `WHATSAPP_API_KEY` in that calling service; these
names belong to the example client. The WhatsApp server's own key override
is named `API_KEY`. A fetch/network exception means no reliable HTTP response
was received; it does not establish whether a send already took place.
The example polls at most ten times and never resends. Persist the job ID in
your own application and continue status checks later if it is still pending.
Use a client deadline that allows media acquisition before acceptance.

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
- Media is fully received, validated, and retained in bounded queue-owned
  staging before HTTP `202`. Downloads and uploads are streamed to disk;
  the entire video or document is not buffered in JavaScript memory. Accepted
  jobs use their staged source instead of fetching the URL again.
- Image and sticker containers are checked and strictly decoded, with at most
  16384 pixels per side, 100 frames, and 40 million total pixels across frames.
  Stickers additionally have a 512-pixel limit per side. Image validation uses
  a byte-limited buffer and a bounded decode; it does not alter the file.
- Audio/video containers, complete framing, tracks, and duration metadata are
  checked. Videos require a video track; audio requests require audio without
  a video track; voice notes require Opus. MIME labels and extensions alone
  cannot make malformed bytes valid media.
- Actual audio/video duration must be positive and at most 24 hours. Audio
  must have a positive sample rate at most 384 kHz and 1 to 32 channels.
- Captions are at most 1024 characters; text messages remain limited to 4096.
  Poll names are at most 256 characters and each option at most 100.
- A media attempt has a 60-second WhatsApp upload timeout. Only failures
  known to occur before the send boundary can be automatically retried.
  After that boundary, uncertain results become `unknown` and are not resent.
- Queue, upload, and staging admission are bounded. Defaults allow 100
  unfinished jobs, one concurrent multipart request, 32 staged files, and a
  256 MiB staging budget. Capacity exhaustion returns `429` with `Retry-After`.
  Staged sources and pending jobs have a five-minute lifetime by default;
  see the [queue configuration](QUEUE.md#configuration-reference).

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

Media validation does not transcode video/audio, resize images, or generate
sticker files. Audio/video checks validate containers and stream metadata;
they do not fully decode every audio/video sample or guarantee client playback.
Document attachments are opaque files: MIME detection does not prove that a
PDF, Office file, archive, or its contents are safe or internally valid.
Prepare a compatible file before calling the endpoint. Request-scoped uploads
and intermediate downloads are removed after staging or rejection; queued
staged files are removed after completion, expiry, or cancellation. No media
source is accepted while depending on a request stream surviving its response.
Allow time for complete acquisition and validation when configuring HTTP
timeouts; processing continues independently after `202`. The 60-second
WhatsApp upload timeout applies later to the worker attempt, not to the
whole admission request.

## Responses

All message types use the same queued response described in
[Track queued messages](#track-queued-messages). Default HTTP `202` means
acceptance, not completion. Delivery/read states belong to the authenticated
job status endpoint. Optional wait mode can return a completed-send `200`
or a known job failure; its job ID always refers to the same accepted work.

| Response field | Type | Meaning |
| --- | --- | --- |
| `success` | Boolean | `true` for acceptance, a successful status/statistics read, or a known completed send; `false` for an API error |
| `jobId` | String | Accepted work's unique ID; retain it for status checks |
| `status` | String | Acceptance/current job state; on status reads this is inside `job` |
| `statusUrl` | String | Relative status path on a `202` response; also returned in the `Location` header |
| `job` | Object | Authenticated status snapshot: ID, session, attempts, timestamps, optional WhatsApp ID and sanitized error |
| `phone` | String | Only in wait-mode completed-send responses; the original request string, including formatting |
| `messageId` | String, optional | The WhatsApp ID when known; found in `job` on status reads or directly on a successful wait response |
| `error` | String or object | Admission/wait error string, or sanitized `{code,retryable}` inside `job` |
| `code` | String, optional | Machine-readable operational code on applicable admission errors |

For example, a completed wait-mode response for
`"phone": "+1 (202) 555-0123"` returns that formatted value in `phone`;
normalization is used internally for delivery. Default acceptance and status
responses omit the phone and message contents. Responses are marked
`Cache-Control: no-store`.

An error response has this shape:

```json
{
  "success": false,
  "error": "Message queue is full; retry later",
  "code": "QUEUE_FULL"
}
```

| Status | Meaning |
| --- | --- |
| `202` | Job accepted, or optional wait expired while the same job remains pending |
| `200` | Status/statistics read, or optional wait completed with a known send result |
| `400` | Invalid request, incompatible options, or invalid media source |
| `401` | Missing or incorrect API key |
| `404` | Endpoint or job not found; retained job may have expired or been lost on restart |
| `405` | Sending attempted with a method other than POST |
| `410` | Media/admission resource expired before acceptance |
| `413` | Request/upload/media exceeds a server limit |
| `415` | Unsupported upload encoding or media format |
| `429` | Queue, upload, or staging capacity full; includes `Retry-After: 1` |
| `502` | Media retrieval failed before acceptance, or wait-mode job has an unknown send outcome |
| `503` | Worker stopping, admission/storage unavailable, session requires authentication, or wait-mode known job failure |
| `504` | Media retrieval timed out |
| `500` | Unexpected server failure |

With the correct key, `GET`, `PUT`, `PATCH`, `DELETE`, and other unsupported
methods on `/api/send` return `405` with `Allow: POST`. Without a valid key,
authentication runs first and the request returns `401`.
Temporary WhatsApp disconnection pauses processing while bounded admission
can continue. A logged-out or failed session rejects new jobs. Public `/ready`
returning `503` is not itself a send rejection and does not cancel accepted
work. Queue status/statistics operations require the key as well.

### Error examples and retry behavior

| HTTP status | Example `error` | What to do |
| --- | --- | --- |
| `400` | `Unexpected request field: caption` | Remove the field if it does not apply to the selected type |
| `400` | `Provide exactly one media source: url or multipart file` | Supply either a URL or one file, never both |
| `400` | `Invalid JSON body` | Correct JSON syntax and use the JSON Content-Type |
| `401` | `Invalid or missing API key` | Set the configured key in `x-api-key` |
| `404` | `Job not found or no longer retained` | Check the saved ID and worker instance; inspect restart/retention history before recreating a message |
| `413` | `Media file exceeds the size limit` | Reduce file size and check the selected type's limit |
| `415` | `Voice notes require an Ogg/Opus audio file` | Supply a correctly encoded Opus recording |
| `415` | `The media file is invalid, incomplete or unsupported` | Replace a damaged, truncated, or spoofed file with valid media |
| `415` | `Use Content-Type application/json or multipart/form-data` | Use JSON or a multipart upload instead of plain text or URL-encoded form data |
| `415` | `The media URL returned an HTML page instead of a file` | Use a direct file URL or multipart upload |
| `429` | `Message queue is full; retry later` | Respect `Retry-After`, add bounded backoff, and inspect queue statistics |
| `429` | `Media staging capacity is full; retry later` | Wait for staged jobs/cleanup to release capacity or reduce the source size |
| `502` | `Media server did not return a downloadable file` | Check that the source URL returns HTTP `200` without login |
| `502` | `AMBIGUOUS_SEND_OUTCOME` with `jobId` and `status: "unknown"` | Poll that job and investigate; do not automatically resend |
| `503` | `WhatsApp session requires authentication` | Inspect `/ping` and pair/repair the session before a new admission |
| `503` | `Message worker is shutting down` | Wait for a healthy assigned worker; check any previously accepted job first |
| `504` | `Media download timed out` | Check the media host or upload the file directly |

Use the HTTP status to classify admission failures and `code` when supplied;
use error text for diagnosis rather than as a permanent machine contract.
For an accepted job, inspect `job.status` and `job.error.code` instead of
equating the status GET's HTTP `200` with a successful send. Read response
bodies for `202` and errors too.

Validation, authentication, capacity, and media-preparation rejection happen
before job commitment. A URL download failure returning `502`/`504` without
a job ID has not queued a future URL fetch; after fixing availability, the
caller may make another request. Accepted jobs already own validated bytes.

The worker retries only safely classified failures before the send boundary,
with bounded exponential backoff and jitter. Temporary disconnects pause the
FIFO until reconnect. Failures after sending may have begun become `unknown`,
and the worker never blindly retries them. A lost HTTP response can also hide
an accepted job, so HTTP/network failure alone does not make a new POST safe.
The local queue prevents duplicate processing of retained job IDs, but has
no durable idempotency key or exactly-once delivery guarantee. Persist job IDs
and known WhatsApp IDs in your calling service. See
[retry policy and crash risks](QUEUE.md#retry-and-disconnection-policy).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Connection refused or no HTTP response | The Node server is running; base URL, port, firewall, and proxy are correct |
| `/ping` returns `503` | Inspect `whatsapp.state`, then use `/qr` if pairing is needed |
| `/ready` returns `503` but `/live` returns `200` | The HTTP process is alive; inspect connection, queue capacity, and shutdown state rather than restarting for every disconnect |
| A send returns `202` without `messageId` | Save `jobId`, call its authenticated status URL, and wait; this is normal queued behavior |
| A job stays `queued` or `retry_wait` | Check connection, session FIFO head, pacing, queue age, and `/api/queue/stats`; do not create another job |
| A request returns `429` | Respect `Retry-After` and reduce admission; inspect queue/staging/upload usage |
| A job is `unknown` | Sending may have occurred; poll for late acknowledgements and investigate before any manual replacement |
| Every send returns `401` | Replace `YOUR_API_KEY`/`{{apiKey}}` and check for an active `API_KEY` override on the server |
| JSON returns `400` | Use **raw > JSON**, keep `phone` as a string, use numbers/booleans with their actual JSON types, and remove irrelevant fields |
| Postman upload says file missing | Use **form-data**, change `file` from Text to File, and select a nonempty file |
| Upload fails after changing its type | Remove incompatible optional fields from the original image upload template |
| Multipart request says boundary missing | Remove the manually entered Content-Type header; let the client generate it |
| Public media URL fails | Open its direct download URL without cookies; check its status, file type, port, size, and HTTP encoding |
| Localhost or LAN media URL is rejected | Use a multipart file upload or a public media host |
| Voice/sticker format is rejected | Supply actual Ogg/Opus or WebP bytes; renaming a file does not convert it |
| Browser reports CORS failure | Call through the interface backend with this testing server configuration |
| A status GET returned `200` but no read receipt | HTTP `200` confirms the status read; inspect `job.status`. Delivery/read acknowledgements can be unavailable or delayed |
| A known job returns `404` | Verify its ID and assigned worker; memory resets on restart and completed statuses expire or are evicted |

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
   Content inspection and image limits are defined in
   [mediaValidation.js](../services/mediaValidation.js).
   Queue behavior and configuration are defined in
   [messageQueue.js](../services/messageQueue.js),
   [messageWorker.js](../services/messageWorker.js), and
   [queue.js](../config/queue.js); update [queue operations](QUEUE.md) alongside
   this usage guide.
4. Run the relevant existing checks, including
   `node --test test/sendTypes.test.js test/messagePayload.test.js` for payload
   or collection changes, and `npm test` for queue/API changes. These use
   fake sockets and offline fixtures.
