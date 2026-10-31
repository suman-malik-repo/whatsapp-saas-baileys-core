# Baileys WhatsApp testing server

One linked WhatsApp account sends text, images, video, audio/voice notes,
documents, stickers, locations, contact cards, and polls over an HTTP API.
Node.js 24 was used to verify this project.
Baileys is pinned to the tested security release `7.0.0-rc14`; the lockfile
records the patched dependency versions. Use `npm ci` for repeatable installs.

## Documentation

- [Message API usage](docs/MESSAGE_API.md): setup, every request type, required
  and optional fields, Postman, cURL, PowerShell, backend examples, and errors.
- [Postman collection](postman/Baileys-WhatsApp.postman_collection.json): import
  it and set `baseUrl`, `apiKey`, and `phone` to try the message requests.
- Pairing and readiness are documented below in this README.

## Start

```powershell
npm install
npm start
```

The default port is `3000`; set `PORT` to change it. Open `/qr` in your browser
when pairing is needed, or scan the QR code printed in the terminal. The HTTP
server starts immediately, while WhatsApp connects in the background.

The fixed testing API key is in `config/apiKey.js`. Send it in the `x-api-key`
header for every `/api` request. To use another fixed key without editing code,
set `API_KEY` before starting Node:

```powershell
$env:API_KEY = "your-shared-test-key"
npm start
```

Authentication is stored in the project's `auth` directory using an absolute
path, so changing the launch directory does not create a separate session.
Keep that directory on persistent storage and run one process per session.

## Send a message

Every type uses `POST /api/send` with a recipient `phone`. Add `type` for a
non-text message. Media accepts a public URL in JSON or a streamed multipart
`file` upload. See the [message API guide](docs/MESSAGE_API.md) for every request
shape, optional field, format, and size limit. You can also import the
[Postman collection](postman/Baileys-WhatsApp.postman_collection.json).

```http
POST /api/send
Content-Type: application/json
x-api-key: YOUR_API_KEY

{"phone":"12025550123","message":"Hello"}
```

`phone` must be a string containing the full international number, including
the country code. An optional leading `+`, spaces, parentheses, and hyphens
are accepted. The normalized number must contain 7–15 digits and cannot start
with zero. Letters, groups, and WhatsApp JIDs are rejected. This validates the
number's shape; it does not verify that the number has a WhatsApp account.

For text requests, `message` must be a nonblank string of at most 4096
JavaScript string code units. Its original spacing and content are preserved.

Example success:

```json
{"success":true,"phone":"12025550123","messageId":"BAILEYS_MESSAGE_ID"}
```

`messageId` is included when Baileys returns one. Success means the Baileys
send call completed; it does not confirm delivery or reading.

Only `POST` is supported for sending. Other methods on `/api/send` return
`405` with `Allow: POST` after authentication. The API key is never accepted
from a query parameter.

| HTTP status | Meaning |
| --- | --- |
| `200` | Send call completed |
| `400` | Invalid input or malformed JSON |
| `401` | Missing or incorrect `x-api-key` |
| `405` | Sending attempted with a method other than POST |
| `413` | Request or media exceeds its size limit |
| `415` | Unsupported request encoding or media format |
| `502` | Media retrieval or WhatsApp send failed |
| `503` | WhatsApp is not connected |
| `504` | Media retrieval timed out |

## Pair from a browser or another service

Open `http://localhost:3000/qr`, enter the same server API key, and choose
**Show QR code**. The page displays a scannable QR image and the exact QR text.
In WhatsApp on your phone, open **Linked devices > Link a device** and scan it.
The page follows connection status and removes the code once connected. The
API key stays in page memory, never in a URL or browser storage.

**Generate fresh QR** requests a new pairing code. The page also refreshes
expired codes while visible. Requests for an already connected account return
its connected status without logging it out or changing its credentials.

Other services can request the exact payload with:

```http
POST /qr
Content-Type: application/json
x-api-key: YOUR_API_KEY

{"fresh":true}
```

Example response:

```json
{
  "success": true,
  "state": "qr_required",
  "connected": false,
  "qr": "THE_EXACT_BAILEYS_QR_TEXT",
  "generatedAt": "2026-10-31T00:00:00.000Z",
  "expiresAt": "2026-10-31T00:00:20.000Z",
  "qrImage": "data:image/png;base64,..."
}
```

Encode `qr` unchanged in your own QR generator, or display `qrImage` directly.
Codes come from Baileys and expire after 20 seconds. Replacing a code invalidates
the previous pairing attempt. Concurrent requests share the same pending attempt.
An empty POST body also requests a fresh code; `{"fresh":false}` reuses a valid
code or waits for the pending connection without replacing it.

Requests wait up to 15 seconds for a QR or connection. A `200` response with
`qr:null` and `connected:false` means pairing is still pending. Poll
`GET /qr/status` with the `x-api-key` header to obtain the current code/status
without generating a new one. Connected responses have `connected:true` and
`qr:null`. Stopped or failed states return `503`; invalid API keys return `401`.
The public GET `/qr` serves only the page; QR data requires the API key.

A fresh request after logout or a bad session preserves the unusable `auth`
directory under `auth-backups/` before starting a new pairing. It never deletes
authentication data. Saved, valid sessions reconnect using their credentials;
fresh requests do not interrupt a scanned code while pairing completes.

## Check readiness

`GET /ping` does not require an API key. It returns `200` only when WhatsApp
is connected and `503` while starting, pairing, reconnecting, stopped, or
requiring operator intervention. Responses are not cached.

```json
{
  "status": "ready",
  "time": "2026-10-31T00:00:00.000Z",
  "whatsapp": {
    "state": "connected",
    "connected": true,
    "reconnectAttempts": 0,
    "nextRetryAt": null,
    "lastDisconnectCode": null
  }
}
```

Temporary connection failures retry with exponential backoff and jitter.
WhatsApp's restart-required response retries promptly. Logout, bad sessions,
forbidden access, connection replacement, and device mismatch stop retries
and remain visible in `/ping`. Use `/qr` to pair again after logout or a bad
session. Resolve other reported conditions before restarting. Auth data is never
automatically deleted. Ctrl+C/SIGTERM stops reconnection and closes the socket
without logging the account out.

CORS configuration is omitted for this testing setup. A browser on a different
origin will need a backend proxy or later CORS configuration.

## Verify

```powershell
npm test
```

Tests use fake WhatsApp sockets and local HTTP listeners. They do not connect
to WhatsApp, send real messages, or read or modify the saved session. Dependency
checks also load the real installed Baileys library, round-trip a text message,
and verify authentication storage using a disposable offline test session.
