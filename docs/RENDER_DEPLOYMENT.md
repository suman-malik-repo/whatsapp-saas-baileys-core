# Deploy a managed Baileys server manually on Render

This guide connects one manually created Render Web Service to the existing
Cloudflare SaaS. Each server belongs to one customer and one WhatsApp account.
The default configuration uses Render Free with no persistent disk.

## Before starting

**Keep this GitHub repository private.** Earlier commits contain WhatsApp
authentication material and server logs. Ignoring those files today does not
remove them from Git history. Do not make this repository public, even briefly.
Render can deploy private repositories using its GitHub integration, so a
visibility change is unnecessary. Revoke any previously exposed linked device
from WhatsApp before pairing a new deployment.

Free hosting is suitable for a test installation. Render documents a 15-minute
idle timeout, about a minute to wake, and loss of local changes on restart,
redeploy or spin-down. Its 750 monthly instance hours are shared by the
workspace; multiple continuously running servers consume that shared budget.
Render can restart Free services without notice and does not recommend them
for production. [Render Free service limits](https://render.com/docs/free)

This server keeps its WhatsApp credentials, journal and callback outbox on the
local filesystem. With no disk, losing those files requires pairing again and
can lose unreported outcomes. Cloudflare retains jobs and send authorization;
an uncertain send must not be blindly submitted again. UptimeRobot requests
cannot restore missing credentials or guarantee an uninterrupted session.

## 1. Connect the private repository to Render

1. Sign in to [Render](https://dashboard.render.com/).
2. Open account settings and find **Git Deployment Credentials**.
3. Add/connect GitHub. In the GitHub authorization screen, give the Render app
   access to `suman-malik-repo/whatsapp-saas-baileys-core`.
4. Return to Render and confirm the private repository appears when creating
   a service. Keep its GitHub visibility private throughout deployment.

If the repository is missing, configure the Render GitHub app's repository
permissions. A service created from a public repository URL can fail to clone
future revisions once that repository becomes private; connect authorized Git
credentials instead. [Render Git provider setup](https://render.com/docs/git-provider)

## 2. Create one unique worker identity and secret

Run these commands locally with Node installed. Save the results in a password
manager; use the same pair in Render and the SaaS admin form:

```powershell
node -e "console.log('wa-worker-' + require('node:crypto').randomUUID())"
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

The first result is `WORKER_ID`. It must contain 8–100 ASCII letters, digits,
underscores or hyphens. The second is `WORKER_SECRET`: 32 random bytes encoded
as 64 hex characters. Generate a different identity and secret for every
Render service. Do not put real values in Git, URLs, screenshots or monitoring
headers. Customer API keys are separate and must not be copied to Render.

## 3. Create a Render Web Service

In Render, choose **New → Web Service**, select the connected private repository
and enter:

| Setting | Value |
| --- | --- |
| Name | A unique name such as `wa-core-test-01` |
| Branch | `main` |
| Region | A region suitable for your users, for example Singapore |
| Runtime / Language | Node |
| Root Directory | Leave blank: this Git repository already contains `package.json` at its root |
| Build Command | `npm ci --omit=dev` |
| Start Command | `npm start` |
| Instance Type | Free |
| Instances | One |
| Health Check Path | `/live` |
| Auto-Deploy | Off / manual deployment |
| Persistent disk | None |

Do not enter `baileys-whatsapp-server` as Root Directory when deploying the
dedicated `whatsapp-saas-baileys-core` repository. That folder name applies to
the local parent workspace, not this repository's remote layout.

Render's Node/Express deployment process accepts an application's own build
and start commands. [Render Node/Express deployment](https://render.com/docs/deploy-node-express-app)

## 4. Add environment variables before the first deploy

Use Render's **Environment** settings:

| Variable | Value |
| --- | --- |
| `NODE_VERSION` | `24` |
| `NODE_ENV` | `production` |
| `MANAGED_MODE` | `true` |
| `MANAGED_STORAGE_MODE` | `ephemeral` |
| `DATA_DIR` | `/tmp/whatsapp-data` |
| `WORKER_ID` | Your unique identity from step 2 |
| `WORKER_SECRET` | Your generated secret from step 2 |
| `GATEWAY_URL` | `https://relaywa-api-production.relaywa-ogemsync.workers.dev` |

Leave `PORT` unset; Render supplies it and the server binds to `0.0.0.0`.
Do not set `API_KEY` for this managed deployment. Do not add Gmail SMTP or
Razorpay credentials here: the Cloudflare application handles those services.
`MEDIA_ALLOWED_ORIGINS` can remain unset because the gateway's origin is
already trusted for signed media delivery.

Use the production API origin shown above, not the dashboard URL, a Pages URL,
or a URL containing `/api`, `/v1` or a trailing path. For an isolated staging
worker use `https://relaywa-api-staging.relaywa-ogemsync.workers.dev` and
register it in the staging admin only. [Render Node version configuration](https://render.com/docs/node-version)

Select **Create Web Service**. Wait for the build and deployment to complete.
The worker starts its HTTP server immediately and retries initial gateway
registration lookup without loading WhatsApp credentials. While it is not yet
registered, `/live` can return 200 and `/ready` can return 503; this is expected.

## 5. Check the deployed HTTP server

Copy the actual HTTPS URL from Render, for example:
`https://wa-core-test-01.onrender.com`.

Open `https://YOUR-ACTUAL-NAME.onrender.com/live`. Expected response:

```json
{"status":"alive"}
```

Only `/live` is the Render health check. `/ping` returns 503 until WhatsApp is
connected, and `/ready` describes the managed worker lifecycle. A QR that has
not yet been scanned is not an HTTP process failure.
[Render HTTP health checks](https://render.com/docs/health-checks)

Managed mode deliberately disables Render's standalone `/api/send` and `/qr`
routes. Pairing and sending go through the Cloudflare dashboard/API.

## 6. Add the server in the SaaS admin panel

1. Open [Production admin login](https://relaywa-web-production.relaywa-ogemsync.workers.dev/admin/login).
2. Log in with your admin account. If prompted, change the initial password.
   An authenticator app is not required for admin setup.
3. Open **Server fleet** → **Register an existing server**.
4. Complete the form:

| Admin field | Enter |
| --- | --- |
| Worker identity | The exact Render `WORKER_ID` |
| Server name | A display name, for example `Test worker 01` |
| Server URL | The actual `https://NAME.onrender.com` origin, without a path |
| Unique managed credential | The exact Render `WORKER_SECRET` |

5. Click **Verify and register** once. Registration stores the server even if
   the initial capability check happens before bootstrap finishes.
6. Allow the worker to retry registration and finish reconciling its state.
   Retries start at 15 seconds and back off to at most one minute.
   Refresh the table, then click **Verify clean** if its status is quarantined.
   A fresh, unassigned worker should become **available**.
7. If verification fails because the Free service was asleep, visit `/live`,
   allow it to wake, and retry **Verify clean**. Do not register the same worker
   a second time: duplicate identity or URL returns a conflict.

The gateway accepts Render HTTPS origins ending in `.onrender.com` and checks
the signed worker identity and protocol. A server that is already assigned,
has unexplained credentials or has failed cleanup cannot be made available
merely by clicking Verify clean.

Manual registration does **not** need a Render API key. Keep automatic
provisioning disabled; **Request provisioning** is the separate paid-service
workflow and is not part of this guide.

## 7. Enable capacity and a test plan in admin

The default launch settings intentionally have no usable free capacity or
message quota. An available server alone does not activate customer sending.

1. Open **Service settings**.
2. Leave **Enable automatic provisioning within these limits** unchecked.
3. Set **Maximum fleet size** and **Maximum free-plan servers** to a small
   deliberate limit, such as `1` each for the first test customer.
4. Keep the remaining provisioning fields valid and save. The displayed paid
   compute/disk defaults apply only to the unused automatic provisioner;
   they do not attach a disk or change a manually created Render service.
5. Open **Plans** and edit the existing Free plan. Set a positive message
   allowance, storage allowance, largest-file limit and desired message types.
   Enable **Make plan available** and save. Do not create a second Free plan.
6. For all currently supported requests, the enabled-type list is:

```text
text,image,video,audio,voice,document,sticker,location,contacts,poll
```

Use conservative testing quotas. Current worker file limits remain image
10 MiB, video 50 MiB, audio/voice 16 MiB, document 100 MiB and sticker 1 MiB;
the plan can reduce them. Leave Razorpay checkout disabled until separately
configured. Avoid selling an availability guarantee backed by a disposable
test service.

## 8. Register a customer and pair WhatsApp

1. Use the customer signup page in another browser/profile or after signing
   out of admin. The customer must activate their email before allocation.
2. After activation, an available server can be assigned within the configured
   plan and free-capacity limits. Waiting customers are handled by allocation
   reconciliation; an admin can also use the customer's allocation action.
3. In the customer's dashboard open **WhatsApp connection** and start pairing.
4. On the phone open WhatsApp → **Linked devices** → **Link a device**, then
   scan the QR shown in the dashboard.
5. Wait for connected status before submitting a message. The pairing screen
   refreshes expired QR codes while open. Requesting a fresh QR must not log
   out an already connected account.
6. Use **Send a message** or create a scoped customer API key. Normal message
   requests target Cloudflare, not the private Render control endpoints.

Example customer request; replace all placeholders and choose a recipient you
are authorized to contact:

```http
POST https://relaywa-api-production.relaywa-ogemsync.workers.dev/v1/messages
Authorization: Bearer CUSTOMER_API_KEY
Content-Type: application/json
Idempotency-Key: unique-request-id-you-will-reuse-for-this-same-payload

{"phone":"+12025550123","type":"text","message":"Deployment test"}
```

A 202 response means durable gateway acceptance, not delivery. Retrieve the
returned job's status. Reuse its idempotency key only with the same payload;
never generate a new request merely because an uncertain send has no result.
Use the [SaaS API documentation](https://relaywa-site-production.pages.dev/docs/)
and [Postman collection](https://relaywa-site-production.pages.dev/downloads/RelayWA.postman_collection.json)
for uploads, media IDs and every message type.

## 9. Configure UptimeRobot

1. Sign in to UptimeRobot and choose **Add New Monitor**.
2. Choose **HTTP(s)**, enter the server's full `/live` URL and give it a name.
3. Select a **5-minute** interval and your alert contact, then create the monitor.
4. Confirm the HTTP endpoint returns 200. No API key or worker secret is needed.
5. Add a separate monitor for each manually created server.

Use HTTP monitoring of `/live`, rather than ICMP Ping or a monitor pointed at
`/ping`, `/qr`, `/ready`, or a Render deploy hook. A deploy hook starts a new
deployment and must not be used as a keep-alive URL.
[UptimeRobot monitor setup](https://help.uptimerobot.com/en/articles/11358364-how-to-create-your-first-monitor-on-uptimerobot-quick-setup-guide),
[monitoring intervals](https://help.uptimerobot.com/en/articles/11360876-what-is-a-monitoring-interval-in-uptimerobot),
[Render deploy hooks](https://render.com/docs/deploy-hooks)

Scheduled HTTP checks can reduce idle gaps, but a green monitor proves only
that the HTTP process answers. Check the SaaS connection state separately.
Monitoring cannot prevent host replacement, retain files, or bypass the Free
workspace's service-hour budget.

## 10. Restart, update and recover safely

For a controlled update while the original state is still available, pause
new allocation using the applicable capacity/plan controls, stop accepting
customer work, finish or reconcile active sends, then disconnect/reset the
assignment through the SaaS before replacing the process. Check that cleanup
completed and the server remains unassigned; stop if another assignment
appears. Deploy the new revision manually, verify the clean worker, restore
capacity and pair again when allocated. Keep Auto-Deploy off to avoid surprise
session loss, including loss caused by an environment-variable redeploy.

If an assigned no-disk worker restarts with its local journal missing, it records
lost local state. The same customer can explicitly pair again; first remove the
obsolete linked device in WhatsApp on the phone. Pending authorized sends may
remain `unknown`; inspect/reconcile them instead of resending automatically.
Pairing again does not recreate lost evidence or callback reports.

If the worker's internal reset/readiness state reports `SESSION_STATE_LOST`,
the admin screen may instead show a generic release failure and quarantined
status. The server cannot prove that the old
linked session and reports were cleaned up. It refuses a clean release and
remains quarantined for reuse. The operator must reconcile the affected jobs
and old assignment and confirm device removal on the phone. This is a manual
recovery incident; there is no automatic reassignment or clean-state override
in this deployment flow. Do not delete D1 rows, edit the journal or replace
worker credentials to bypass the quarantine. Keep that server out of the pool
until its prior assignment has been resolved.

## Optional: preserve sessions using a paid service later

The requested no-disk configuration is the default [render.yaml](../render.yaml).
The separate [render.persistent.yaml](../render.persistent.yaml) is an optional
paid template, with a disk mounted at `/var/data`,
`MANAGED_STORAGE_MODE=persistent`, and `DATA_DIR=/var/data`. Selecting the
storage-mode variable alone does not provision a disk. Keep one instance per
account and store the entire configured data directory, including its journal
and auth backups. Only files under the mount survive replacements.
[Render persistent disks](https://render.com/docs/disks)

Moving to a disk does not recover already lost credentials, callbacks or send
evidence. Resolve the old assignment first and pair explicitly when necessary.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Git clone fails | Keep the repository private and grant Render's GitHub app access to it; verify the service's Git credentials. |
| Build fails to find `package.json` | Clear Root Directory when deploying the dedicated core repository. |
| HTTP service does not start | Check Node 24, `npm ci --omit=dev`, required env values and Render logs. |
| `/live` is 200 but `/ready` is 503 | Confirm exact gateway origin, matching worker identity/secret and admin registration. Initial lookup retries automatically; ownership/storage errors require recovery. |
| Server registered but quarantined | Wait for bootstrap, wake `/live`, then Verify clean. An assigned or lost-state server needs its recovery procedure. |
| `/ping` is 503 | Pair WhatsApp or inspect its connection state; this does not mean the HTTP process failed. |
| `/qr` or `/api/send` is 404 | Expected in managed mode; use the Cloudflare dashboard and `/v1/messages`. |
| Customer remains waiting | Check email activation, active plan, positive free-capacity limit and an available healthy server. |
| QR stopped working | Request a fresh QR from the customer's pairing screen and scan promptly. |
| Session disappears after restart | Expected without persistence; remove the obsolete linked device and follow lost-state recovery. |
| Requests have `unknown` status | Possible transmission occurred. Preserve the job and reconcile; do not automatically send it again. |
| UptimeRobot is up but sending fails | `/live` checks HTTP only; inspect pairing, assignment, plan quota and message status. |

For protocol details and operational bounds, see
[Managed worker protocol](MANAGED_WORKER.md). This guide does not create Render
resources, change repository visibility, or send a test message automatically.
