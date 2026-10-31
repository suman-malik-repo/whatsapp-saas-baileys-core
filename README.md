# Baileys WhatsApp message worker

One linked WhatsApp account sends text, images, video, audio/voice notes,
documents, stickers, locations, contact cards, and polls over an HTTP API.
Validated requests enter a bounded local queue with per-session FIFO,
concurrency limits, pacing, safe retries, and delivery/read status tracking.
The queue is in memory: jobs and status records do not survive a process exit.
Node.js 24 was used to verify this project.
Baileys is pinned to the tested security release `7.0.0-rc14`; the lockfile
records the patched dependency versions. Use `npm ci` for repeatable installs.

## Documentation

- [Message API usage](docs/MESSAGE_API.md): setup, every request type, required
  and optional fields, Postman, cURL, PowerShell, backend examples, and errors.
- [Postman collection](postman/Baileys-WhatsApp.postman_collection.json): import
  it and set `baseUrl`, `apiKey`, and `phone`; accepted sends save `jobId` for
  the included status request.
- [Queue operation](docs/QUEUE.md): architecture, all environment variables,
  lifecycle, backpressure, retries, shutdown, limits, and Render deployment.
- [Cloudflare integration plan](docs/CLOUDFLARE_INTEGRATION.md): proposed
  Workers/D1/R2 handoff, leases, fencing, tenant boundaries, and recovery.
- Pairing and readiness are documented below in this README.

## Start

```powershell
npm ci
npm start
```

The default port is `3000`; set `PORT` to change it. Open `/qr` in your browser
when pairing is needed, or scan the QR code printed in the terminal. The HTTP
server starts immediately, while WhatsApp connects in the background.
No external queue or database is required. The default API accepts jobs with
HTTP `202`; sending starts asynchronously when the session is connected.

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
are accepted. The raw value is limited to 64 characters; tabs and line breaks
are rejected. The normalized number must contain 7–15 digits and cannot start
with zero. Letters, groups, and WhatsApp JIDs are rejected. This validates the
number's shape; it does not verify that the number has a WhatsApp account.

For text requests, `message` must be a nonblank string of at most 4096
JavaScript string code units. Its original spacing and content are preserved.
Strings must contain valid Unicode and no unsafe control characters. Media
is fully received, validated, and staged before acceptance; see the API guide for format,
image-dimension, size, and duration rules.

Example HTTP `202 Accepted` response:

```json
{
  "success": true,
  "jobId": "5ed5825f-09ab-45a5-b75d-48cc933b0234",
  "status": "queued",
  "statusUrl": "/api/messages/5ed5825f-09ab-45a5-b75d-48cc933b0234"
}
```

The response includes a `Location` header with the status path. Save `jobId`
and request `GET /api/messages/:jobId` with the same `x-api-key`. It returns
`{ "success": true, "job": { ... } }` with status, attempts, timestamps,
the WhatsApp `messageId` when known, and a sanitized error code when needed.
The snapshot omits the recipient and message contents.

Normal progress is `queued -> processing -> sent -> delivered -> read`.
`sent` confirms the Baileys send result, not recipient delivery. Acknowledgements
may be missing or delayed. Safe pre-send failures can enter `retry_wait`;
permanent failures enter `failed`, and uncertain send results enter `unknown`
without automatic resending. Do not repeat an accepted POST to check progress.

For callers migrating from the former immediate `200` response, use
`POST /api/send?wait=true` or `QUEUE_API_MODE=wait`. Waiting defaults to at
most 25 seconds, then returns `202` for the same job if it is still pending.
A completed send returns `200` with `phone`, `messageId`, `jobId`, and `status`.
An ambiguous result returns `502` with that job's ID, `status: "unknown"`, and
an error code. `wait=false` selects immediate acceptance for one request.
Only the optional `wait=true` or `wait=false` query parameter is supported.

Only `POST` is supported for sending. Other methods on `/api/send` return
`405` with `Allow: POST` after authentication. The API key is never accepted
from a query parameter.

| HTTP status | Meaning |
| --- | --- |
| `202` | Job accepted; inspect its status URL |
| `200` | Optional wait completed with a known send result |
| `400` | Invalid input or malformed JSON |
| `401` | Missing or incorrect `x-api-key` |
| `405` | Sending attempted with a method other than POST |
| `413` | Request or media exceeds its size limit |
| `415` | Unsupported request encoding or media format |
| `429` | Queue, upload, or staging capacity is full; includes `Retry-After` |
| `502` | Media retrieval failed before acceptance, or optional wait has an unknown send outcome |
| `503` | Worker stopping, admission unavailable, or authentication requires attention |
| `504` | Media retrieval timed out |

Temporary disconnection pauses processing; eligible jobs can still be accepted
within the queue limits. Logged-out or failed sessions reject new work. See
the [complete response and retry reference](docs/MESSAGE_API.md#responses).

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

`GET /live` returns `200` while the HTTP process can respond. `GET /ready`
returns `200` when the worker is accepting work, has queue capacity, and
WhatsApp is connected; otherwise it returns `503`. Both are public and expose
no QR, credentials, recipients, or message contents.

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
automatically deleted.

`GET /api/queue/stats` requires the API key and returns pending/active/retrying
counts, send/failure/unknown counters, waiting time, connection state, and
media staging usage. Job status and statistics are retained locally within
configured bounds, not persisted across restarts.

## Queue operation and Render

The defaults allow 100 unfinished jobs globally, one active send per session,
a one-second minimum attempt interval, a one-token burst, two safe retries,
five-minute pending-job age, and bounded media staging. These are operational
testing settings, not a guarantee against WhatsApp restrictions. Configure
limits through the [queue environment reference](docs/QUEUE.md#configuration-reference).
Delayed retries keep the session's FIFO head; later jobs wait. Other independent
session queues can proceed, but the HTTP server currently exposes one account.

Ctrl+C/SIGTERM stops accepting new work, cancels unstarted jobs, and drains
active attempts for up to `QUEUE_DRAIN_MS` (10 seconds by default). Uncertain
in-flight sends become `unknown`; credentials are saved and the socket closes
without logging out. A crash loses local jobs/statuses and may leave a send
whose result cannot be recovered. Blindly recreating it risks a duplicate.

On Render use `npm ci`, `npm start`, Node 24, and the supplied `PORT`.
Use `/live` for the Render HTTP health check and monitor `/ready` separately,
so pairing does not cause restart loops. Persist the actual source-root
`auth` directory, run one process per account, and allow for deployment
interruptions. Auth persistence does not make the queue durable. See
[deployment details and verified Render references](docs/QUEUE.md#render-deployment-notes).
The [Cloudflare plan](docs/CLOUDFLARE_INTEGRATION.md) describes the remaining
work needed for durable tenant-aware orchestration; no D1 access or gateway
deployment is required by this local worker.

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
