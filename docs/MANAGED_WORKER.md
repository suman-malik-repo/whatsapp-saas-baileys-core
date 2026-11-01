# Managed Render worker protocol

The standalone API remains unchanged unless `MANAGED_MODE=true`. Managed mode
disables `/api/*` and `/qr`; only `/live`, readiness endpoints and the signed
`/internal/v1/*` control interface are available. Customer API keys never reach
Render. The Cloudflare gateway owns tenants, jobs, quotas and billing.

## Deployment

Use Node 24, one process and a dedicated paid Render service with a persistent
disk. `render.yaml` is the reference template. The SaaS provisioner sets:

| Variable | Meaning |
|---|---|
| `MANAGED_MODE` | Exactly `true` to enable gateway-only mode |
| `WORKER_ID` | Unique gateway registry ID |
| `WORKER_SECRET` | Unique random secret, at least 32 bytes |
| `GATEWAY_URL` | HTTPS gateway origin, without a path |
| `DATA_DIR` | Absolute persistent disk path, normally `/var/data` |
| `MEDIA_ALLOWED_ORIGINS` | Optional comma-separated gateway-controlled R2 origins |
| `PORT` | Render-supplied listening port |

Register the worker ID and secret in Cloudflare before boot. Never share disks
or horizontally scale one linked WhatsApp account. Keep automatic deployments
off and drain/upgrade one server at a time.

At startup the worker fetches its authoritative assignment before loading any
credentials. A mismatched assignment, unexplained auth files/backups, corrupt
journal, failed journal write, or failed cleanup quarantines the server. A new
unassigned server stays idle. A linked account reconnects only after matching
the journal assignment; an unlinked account starts pairing on explicit request.

## Authentication

Every internal request and callback uses these headers:

```text
x-worker-id: WORKER_ID
x-timestamp: epoch milliseconds
x-signature: lowercase hex HMAC-SHA256
```

The HMAC input is the uppercase method, URL pathname, timestamp and hexadecimal
SHA-256 of the exact raw body, separated by newline characters:

```text
METHOD\n/pathname\ntimestamp\nsha256(rawBody)
```

The timestamp must be within five minutes. The query is excluded from the
signature; GET handlers still require the currently owned assignment ID and
fence. Mutations use durable operation IDs or job/attempt IDs to make replays
idempotent. HTTPS is mandatory outside localhost development.

## Worker endpoints

All paths below begin `/internal/v1`.

| Method/path | Body or query | Behavior |
|---|---|---|
| `GET /capabilities` | None | `workerId`, `protocolVersion:1`, `version`, supported types/limits, readiness and verified `clean` flag |
| `POST /assignment` | `operationId,tenantId,assignmentId,fence` | Independently rechecks authoritative gateway assignment and persists ownership |
| `POST /pairing` | `operationId,assignmentId,fence,fresh?` | Starts pairing and returns current QR snapshot |
| `GET /qr` | Query `assignmentId,fence` | QR text, data URL image, generation hash and expiry |
| `POST /reset` | `operationId,assignmentId,fence` | Drains, revokes linked account, clears auth/backups, reports outcomes and removes customer journal residue |
| `POST /jobs/dispatch` | Dispatch shape below | Durable admission; returns `202` and attempt status |
| `GET /jobs/:jobId` | Query `assignmentId,fence` | Reconciliation state for this assignment |
| `POST /media/inspect` | `operationId,tenantId,assignmentId,fence,mediaId,url,type,expectedSize?,expectedSha256?,mimetype?` | Bounded download and byte/container validation; returns `success,size,sha256,mimetype,metadata` |
| `POST /media/import` | Same, public HTTPS source URL | Validates source, obtains scoped gateway upload grant, uploads exact bytes and durably reports result |

QR responses are never cached or logged. A request for a fresh QR cannot log out
an already linked account. The same pairing operation returns the current
snapshot; use a new operation ID when explicitly requesting a replacement.

Example dispatch (optional fields depend on the existing message type):

```json
{
  "jobId": "job-generated-by-gateway",
  "tenantId": "tenant-1",
  "assignmentId": "assignment-1",
  "assignmentFence": 1,
  "attemptId": "attempt-1",
  "attemptFence": 1,
  "leaseExpiresAt": 1793533260000,
  "payload": { "phone": "12025550123", "type": "image", "caption": "Example" },
  "media": {
    "mediaId": "media-1",
    "url": "https://gateway.example/internal/v1/media/media-1/content?grant=SHORT_LIVED_GRANT",
    "sha256": "64-lowercase-hex-characters",
    "size": 12345
  }
}
```

The example timestamp and checksum are placeholders. Media source URLs must use
the gateway origin or an explicitly configured controlled origin. Downloads
also pass the existing DNS/IP pinning, redirect, byte and container checks.
Dispatch media must match both expected size and SHA-256. Media-free dispatch
uses the unchanged text/location/contacts/poll request fields.

## Gateway callbacks

Callbacks use the same HMAC scheme and a 15-second request timeout.

| Method/path | Required behavior |
|---|---|
| `GET /internal/v1/workers/:workerId/assignment` | Return `{assignment:null}` or `{assignment:{id,tenantId,fence}}` |
| `POST /internal/v1/workers/:workerId/heartbeat` | Persist assignment/fence, lifecycle state, connection state and capabilities; worker emits every 15 seconds |
| `POST /internal/v1/jobs/:jobId/lease` | Renew only the current attempt/assignment; return `{leaseExpiresAt}`; worker renews every 15 seconds while processing |
| `POST /internal/v1/jobs/:jobId/send-start` | Durably fence/authorize one attempt; return `{authorized:true,leaseExpiresAt,authorizationExpiresAt}` |
| `POST /internal/v1/jobs/:jobId/events` | Deduplicate `eventId`, verify assignment/attempt fences and apply monotonic status |
| `POST /internal/v1/media/:mediaId/import-target` | Verify assignment and expected metadata, return exact-size one-use `{url,headers}` PUT grant |
| `POST /internal/v1/media/:mediaId/result` | Deduplicate result event, verify assignment and immutable object integrity |

Send-start includes `eventId,assignmentId,assignmentFence,attemptId,attemptFence,
messageId`. Status events include those ownership fields plus `status` and
optional `messageId,errorCode,retryable`. Media results include
`eventId,assignmentId,fence,success` plus validated metadata or `errorCode`.

## Durability and failure behavior

`managed-journal.json` is a bounded checksummed snapshot, serialized through one
writer. Each update fsyncs a new file, atomically renames it and fsyncs the
directory before acknowledgement. It holds at most 10,000 jobs, 20,000 pending
reports, 10,000 operation IDs and 16 MiB. Capacity exhaustion rejects new work;
storage failure quarantines the server. A process lock prevents two workers
from opening one data directory. Render's Linux deployment requires directory
fsync; Windows development tolerates unsupported directory fsync.

Dispatch admission is persisted before `202`. The worker stages/validates media,
awaits durable gateway send authorization and persists send intent before calling
Baileys. Pre-send safe failures may retry with a higher attempt fence, unchanged
payload and a new attempt ID. Repeating an attempt cannot cause a second send.

Any error after durable intent becomes `unknown` and quarantines the socket.
Restarted pre-intent jobs report a safe failure; restarted send-intent jobs
report `unknown`. Reporting failures retry the durable outbox rather than the
WhatsApp call. Late delivered/read receipts can advance `unknown` or `sent`.

One send runs at a time with at least one second between attempts. The send
deadline is 90 seconds. The gateway remains responsible for FIFO, retry limits,
quota reservation and treating a lost send-authorization response as uncertain.

Terminal records and completed operation IDs retain 30 days; unresolved unknown
records and unacknowledged reports remain until operator reconciliation. The
snapshot is compacted on each durable update. Monitor retained record count and
provide capacity before a high-volume account reaches the fixed journal limit.
Limits are configurable with `MANAGED_JOURNAL_MAX_JOBS` (maximum 100,000),
`MANAGED_JOURNAL_MAX_EVENTS` (maximum 200,000) and `MANAGED_JOURNAL_MAX_BYTES`
(maximum 256 MiB). Size the Render memory profile for these limits: snapshot
updates temporarily retain several in-memory copies. Defaults target small
dedicated accounts; do not sell quotas beyond the configured retained capacity.

## Release and recovery

Successful reset requires confirmed WhatsApp revocation and acknowledgement of
all old reports, then deletes old auth files/backups and journal job residue.
Only a verified clean worker may re-enter the allocation pool. A repeated reset
operation is idempotent. Do not remove a persistent disk or clear the journal to
make a failed reset appear clean.

An assigned quarantined worker with verified gateway ownership can receive an
operator reset. If necessary it reconnects only to revoke its linked account.
Failed revocation or report delivery keeps it quarantined. For corrupt storage
or mismatched ownership, drain/quarantine in Cloudflare, reconcile all jobs and
unlink the device in WhatsApp before replacing the dedicated service/disk.

The automated tests use temporary directories and mocked Baileys sockets. They
never load the real auth directory, create a real WhatsApp connection or send a
real message.
