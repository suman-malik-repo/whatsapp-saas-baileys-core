# Managed Render worker protocol

The standalone API remains unchanged unless `MANAGED_MODE=true`. Managed mode
disables `/api/*` and `/qr`; only `/live`, readiness endpoints and the signed
`/internal/v1/*` control interface are available. Customer API keys never reach
Render. The Cloudflare gateway owns tenants, jobs, quotas and billing.

## Deployment

Use Node 24, one process and a dedicated Render Web Service. Follow the
[manual Render deployment guide](RENDER_DEPLOYMENT.md) for the exact dashboard
settings, private GitHub access, no-disk environment, admin registration and
UptimeRobot setup. `render.yaml` is the manual Free/no-disk testing template;
`render.persistent.yaml` is the optional paid/disk alternative. Configure:

| Variable | Meaning |
|---|---|
| `MANAGED_MODE` | Exactly `true` to enable gateway-only mode |
| `WORKER_ID` | Unique gateway registry ID |
| `WORKER_SECRET` | Unique random secret, at least 32 bytes |
| `GATEWAY_URL` | HTTPS gateway origin, without a path |
| `MANAGED_STORAGE_MODE` | `ephemeral` by default; `persistent` only with an actual mounted disk |
| `DATA_DIR` | Absolute data path: `/tmp/whatsapp-data` for no disk, `/var/data` for the mounted-disk alternative |
| `MEDIA_ALLOWED_ORIGINS` | Optional comma-separated gateway-controlled R2 origins |
| `PORT` | Render-supplied listening port |

Register the exact worker ID and secret in the Cloudflare admin panel. Initial
transient gateway/registration failures retry while HTTP liveness remains
available; credentials are not loaded during that wait. Finish bootstrap and
use **Verify clean** to admit a new server to the pool. Never share directories
or horizontally scale one linked WhatsApp account. Keep automatic deployments
off and drain/upgrade one server at a time. Manual registration requires no
Render API key and does not enable the paid automatic provisioner.

At startup the worker fetches its authoritative assignment before loading any
credentials. A mismatched assignment, unexplained auth files/backups, corrupt
journal, failed journal write, or failed cleanup quarantines the server. A new
unassigned server stays idle. A linked account reconnects only after matching
the journal assignment; an unlinked account starts pairing on explicit request.
If a remotely assigned server has lost its local journal, it records lost
local state. Its current customer can explicitly pair again, but reset cannot
claim a confirmed-clean release of the previous session/evidence. Follow the
recovery procedure below before reusing it for anyone else.

Keep the core repository private. Historical Git commits contain auth files
and logs; current ignore rules do not remove that history. Render's GitHub
integration can clone the private repository without a visibility change.

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
| `GET /capabilities` | None | Identity, protocol version, storage mode/durability, supported types/limits, readiness and verified `clean` flag |
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

`managed-journal.json` is a bounded checksummed file snapshot, serialized through
one writer in both storage modes. Each update fsyncs a new file, atomically
renames it and fsyncs the directory before acknowledgement. File writes protect
against process-level interruption while the filesystem survives; they cannot
preserve state on an ephemeral host replacement. Capabilities describe the
configured storage guarantee; setting `persistent` does not attach a disk.

Without a disk, host restart/replacement, redeploy or spin-down can remove
credentials, callback reports, operation IDs and receipt mappings. Cloudflare
retains authoritative jobs and send authorization, but cannot reconstruct
missing WhatsApp credentials or prove a missing result. Same-customer recovery
requires explicit pairing and uncertain sends remain counted and unretried.
Use no-disk hosting for a test installation whose operator accepts this recovery
requirement; a periodic `/live` monitor is not persistence.

The snapshot holds at most 10,000 jobs, 20,000 pending
reports, 10,000 operation IDs and 16 MiB. Capacity exhaustion rejects new work;
storage failure quarantines the server. A process lock prevents two workers
from opening one data directory. Render's Linux deployment requires directory
fsync; Windows development tolerates unsupported directory fsync.

Dispatch admission is written and synced before `202`. The worker stages/validates media,
awaits durable gateway send authorization and persists send intent before calling
Baileys. Pre-send safe failures may retry with a higher attempt fence, unchanged
payload and a new attempt ID. Repeating an attempt cannot cause a second send.

Any error after durable intent becomes `unknown` and quarantines the socket.
When the journal survives a restart, pre-intent jobs report a safe failure and
send-intent jobs report `unknown`. Reporting failures retry the file-backed
outbox rather than the WhatsApp call. If an ephemeral replacement erased the
outbox, it cannot replay those missing reports; Cloudflare lease reconciliation
retains uncertainty for authorized attempts. Late delivered/read receipts can
advance `unknown` or `sent` when their mapping remains available.

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

After loss of local state for an existing assignment, the worker's internal
reset/readiness state reports `SESSION_STATE_LOST` rather than claim that a
missing credential directory proves remote logout. The gateway/admin may show
a generic release failure and quarantined status. The server remains quarantined
for reuse. The operator must
remove the obsolete device in WhatsApp **Linked devices**, reconcile unresolved
jobs and the prior assignment, and resolve the recovery incident before any
pool reuse. The existing reset/Verify flow does not provide an override for this
condition. Re-pairing the current customer alone does not restore lost evidence
or clear that safety restriction. Do not delete D1 rows or manufacture a clean
journal to bypass it.

An assigned quarantined worker with verified gateway ownership can receive an
operator reset. If necessary it reconnects only to revoke its linked account.
Failed revocation or report delivery keeps it quarantined. For corrupt storage
or mismatched ownership, drain/quarantine in Cloudflare, reconcile all jobs and
unlink the device in WhatsApp before replacing the dedicated service/disk.

The automated tests use temporary directories and mocked Baileys sockets. They
never load the real auth directory, create a real WhatsApp connection or send a
real message.
