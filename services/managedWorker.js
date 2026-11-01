const fs = require("node:fs")
const path = require("node:path")
const { createHash, randomUUID } = require("node:crypto")
const { createMediaStaging } = require("./mediaStaging")
const { createManagedJournal } = require("./managedJournal")
const { createGatewayClient, validId, managedError } = require("./managedProtocol")
const { buildMessagePayload, MEDIA_LIMITS } = require("../utils/messagePayload")

const VERSION = "managed-v1"
const TERMINAL = new Set(["sent", "delivered", "read", "failed", "cancelled", "unknown"])
const RANK = { sent: 1, delivered: 2, read: 3 }
function fingerprint(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex") }
function fence(value) {
 if (!Number.isSafeInteger(value) || value < 1) throw managedError(400, "INVALID_FENCE", "A positive assignment fence is required")
 return value
}
function safeError(error, fallback = "WORKER_OPERATION_FAILED") { return /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code || "") ? error.code : fallback }
function boundedSetting(env, name, fallback, maximum) {
 const raw = env[name] ?? String(fallback)
 if (!/^[1-9]\d*$/.test(String(raw)) || !Number.isSafeInteger(Number(raw)) || Number(raw) > maximum) throw new Error(`${name} is invalid`)
 return Number(raw)
}

function createManagedWorker(options = {}) {
 const env = options.env || process.env
 const workerId = validId(env.WORKER_ID, "WORKER_ID")
 const secret = env.WORKER_SECRET
 if (typeof secret !== "string" || Buffer.byteLength(secret) < 32) throw new Error("WORKER_SECRET must contain at least 32 bytes")
 if (!env.DATA_DIR || !path.isAbsolute(env.DATA_DIR)) throw new Error("Managed mode requires an absolute DATA_DIR")
 const dataDir = path.resolve(env.DATA_DIR)
 const connection = options.connection || require("../config/socket")
 const gateway = options.gateway || createGatewayClient({ gatewayUrl: env.GATEWAY_URL, workerId, secret })
 const now = options.now || Date.now
 const generateMessageId = options.generateMessageId || ((sock) => require("@whiskeysockets/baileys").generateMessageIDV2(sock.user?.id))
 const staging = options.staging || createMediaStaging()
 const drainMs = options.drainMs ?? 10000
 const sendTimeoutMs = options.sendTimeoutMs ?? 90000
 const minIntervalMs = options.minIntervalMs ?? 1000
 let journal, boot, executing, shutdownPromise, timer, heartbeatBusy = false, flushing = false, stopped = false
 let ready = false, ownershipConfirmed = false, quarantineReason = null, nextSendAt = 0, control = Promise.resolve(), controlPending = 0
 const unsubscribeUpdates = connection.subscribeMessageUpdates?.((update) => receipt(update).catch(() => quarantine("JOURNAL_WRITE_FAILED")))
 const capabilities = () => ({ protocol: VERSION, protocolVersion: 1, version: VERSION, workerId, managed: true, durable: true,
  clean: ready && !snapshot()?.assignment && snapshot()?.state === "unassigned" && !Object.keys(snapshot()?.jobs || {}).length && !snapshot()?.outbox.length,
  messageTypes: ["text", ...Object.keys(MEDIA_LIMITS), "location", "contacts", "poll"], mediaLimits: MEDIA_LIMITS,
  lifecycle: true, mediaInspection: true, mediaImport: true })
 function snapshot() { return journal?.read() }
 async function quarantine(reason) {
  ready = false; quarantineReason = reason
  if (journal) await journal.update((data) => { data.state = "quarantined" }).catch(() => {})
  await connection.stopWhatsApp().catch(() => {})
 }
 function assertReady() {
  if (!ready || stopped || !journal || snapshot().state === "quarantined") throw managedError(503, "WORKER_QUARANTINED", "Worker is not ready for managed operations")
 }
 function assertAssignment(body, { allowDraining = false, allowQuarantined = false } = {}) {
  if (allowQuarantined) {
   if (!ownershipConfirmed || !journal || stopped) throw managedError(503, "WORKER_QUARANTINED", "Worker ownership has not been confirmed")
  } else assertReady()
  const data = snapshot()
  const assignment = data.assignment
  const supplied = body.assignmentFence ?? body.fence
  if (!assignment || body.assignmentId !== assignment.id || fence(supplied) !== assignment.fence ||
      (body.tenantId !== undefined && body.tenantId !== assignment.tenantId)) throw managedError(409, "STALE_ASSIGNMENT", "Assignment does not own this worker")
  if (!allowDraining && data.state === "draining") throw managedError(409, "WORKER_DRAINING", "Worker is draining")
  return assignment
 }
 function eventFor(job, status, extras = {}) {
  return { path: `/internal/v1/jobs/${job.jobId}/events`, body: {
   eventId: randomUUID(), assignmentId: job.assignmentId, assignmentFence: job.assignmentFence,
   attemptId: job.attemptId, attemptFence: job.attemptFence, status, ...extras
  }, createdAt: now() }
 }
 async function complete(jobId, status, extras = {}) {
  await journal.update((data) => {
   const job = data.jobs[jobId]
   if (!job) return
   if (RANK[job.status] && (!RANK[status] || RANK[status] <= RANK[job.status])) return
   if (TERMINAL.has(job.status) && !["sent", "delivered", "read", "unknown"].includes(job.status)) return
   job.status = status; job.updatedAt = now()
   Object.assign(job, extras)
   delete job.payload; delete job.media
   data.outbox.push(eventFor(job, status, extras))
  })
  void flush()
 }
 async function receipt(update) {
  if (!journal || !["delivered", "read"].includes(update.status)) return
  const job = Object.values(snapshot().jobs).find((item) => item.messageId === update.messageId)
  if (job && ["sending", "unknown", "sent", "delivered", "read"].includes(job.status)) await complete(job.jobId, update.status, { messageId: update.messageId })
 }
 async function flush() {
  if (flushing) return flushing
  if (!journal || stopped) return
  const operation = (async () => { try {
   for (let count = 0; count < 100; count++) {
    const event = snapshot().outbox[0]
    if (!event) break
    await gateway(event.path, event.body)
    await journal.update((data) => { data.outbox = data.outbox.filter((item) => item.body.eventId !== event.body.eventId) })
   }
  } catch { /* The durable outbox owns retry; never repeat a WhatsApp send. */ }
  })()
  flushing = operation
  void operation.finally(() => { if (flushing === operation) flushing = null })
  return operation
 }
 async function bootWorker() {
  if (boot) return boot
  boot = (async () => {
   try {
    journal = await createManagedJournal({ dataDir,
     maxJobs: boundedSetting(env, "MANAGED_JOURNAL_MAX_JOBS", 10000, 100000),
     maxEvents: boundedSetting(env, "MANAGED_JOURNAL_MAX_EVENTS", 20000, 200000),
     maxBytes: boundedSetting(env, "MANAGED_JOURNAL_MAX_BYTES", 16 * 1024 * 1024, 256 * 1024 * 1024) })
    const remote = await gateway(`/internal/v1/workers/${workerId}/assignment`, undefined, "GET")
    const assigned = remote.assignment
    if (assigned) { validId(assigned.id); validId(assigned.tenantId); fence(assigned.fence) }
    const local = snapshot()
    const same = assigned && local.assignment && assigned.id === local.assignment.id && assigned.tenantId === local.assignment.tenantId && assigned.fence === local.assignment.fence
    let files = []
    try { files = await fs.promises.readdir(path.join(dataDir, "auth")) } catch (error) { if (error.code !== "ENOENT") throw error }
    let backups = []
    try { backups = await fs.promises.readdir(path.join(dataDir, "auth-backups")) } catch (error) { if (error.code !== "ENOENT") throw error }
    if (same) ownershipConfirmed = true
    if (local.state === "quarantined" || local.state === "draining" || (local.assignment && !same) || (!local.assignment && (files.length || backups.length))) throw new Error("Assignment reconciliation failed")
    await journal.update((data) => {
     data.assignment = assigned || null; data.state = assigned ? "assigned" : "unassigned"
     for (const job of Object.values(data.jobs)) if (!TERMINAL.has(job.status)) {
      const uncertain = job.status === "sending"
      job.status = uncertain ? "unknown" : "failed"; job.updatedAt = now()
      const extras = { ...(job.messageId ? { messageId: job.messageId } : {}), errorCode: uncertain ? "AMBIGUOUS_SEND_OUTCOME" : "WORKER_RESTARTED", retryable: !uncertain }
      delete job.payload; delete job.media
      data.outbox.push(eventFor(job, job.status, extras))
     }
    })
    ownershipConfirmed = true; ready = true
    // Reconnect an already linked account only after durable ownership matches.
    if (same && files.includes("creds.json")) {
     const creds = JSON.parse(await fs.promises.readFile(path.join(dataDir, "auth", "creds.json"), "utf8"))
     if (creds.registered || creds.me?.id) await connection.startWhatsApp()
    }
    timer = setInterval(() => { void heartbeat(); void flush(); prune().catch(() => quarantine("JOURNAL_WRITE_FAILED")) }, 15000)
    timer.unref?.()
    void heartbeat(); void flush()
   } catch { await quarantine("BOOTSTRAP_RECONCILIATION_FAILED") }
  })()
  return boot
 }
 async function heartbeat() {
  if (heartbeatBusy || stopped || !journal) return
  heartbeatBusy = true
  try {
   const data = snapshot()
   const status = connection.getConnectionStatus()
   await gateway(`/internal/v1/workers/${workerId}/heartbeat`, {
    ...(data.assignment ? { assignmentId: data.assignment.id, fence: data.assignment.fence } : {}),
    state: data.state, connected: status.connected, connectionState: status.state, capabilities: capabilities(), version: VERSION
   })
  } catch { /* Send authorization remains mandatory when the gateway is offline. */ }
  finally { heartbeatBusy = false }
 }
 async function prune() {
  if (!journal || stopped) return
  const time = now(), data = snapshot()
  const pending = new Set(data.outbox.map((event) => event.body.jobId || event.path.split("/")[4]))
  const oldJobs = Object.values(data.jobs).filter((job) => TERMINAL.has(job.status) && job.status !== "unknown" && job.updatedAt < time - 30 * 86400000 && !pending.has(job.jobId))
  const oldOps = Object.entries(data.operations).filter(([, operation]) => operation.at < time - 30 * 86400000)
  if (!oldJobs.length && !oldOps.length) return
  await journal.update((next) => { oldJobs.forEach((job) => delete next.jobs[job.jobId]); oldOps.forEach(([id]) => delete next.operations[id]) })
 }
 function serializedControl(action) {
  if (controlPending >= 32) return Promise.reject(managedError(429, "CONTROL_CAPACITY", "Worker control capacity is full"))
  controlPending++
  const operation = control.then(action)
  control = operation.catch(() => {})
  return operation.finally(() => { controlPending-- })
 }
 function operationState(data, body) {
  validId(body.operationId, "Operation ID")
  const previous = data.operations[body.operationId]
  if (previous && previous.hash !== fingerprint(body)) throw managedError(409, "OPERATION_CONFLICT", "Operation ID was already used with different parameters")
  return previous
 }
 async function assign(body) {
  return serializedControl(async () => {
   assertReady(); validId(body.assignmentId); validId(body.tenantId); fence(body.fence)
   const data = snapshot(), previous = operationState(data, body)
   if (previous) return previous.result
   if (data.assignment && (data.assignment.id !== body.assignmentId || data.assignment.tenantId !== body.tenantId || data.assignment.fence !== body.fence)) throw managedError(409, "WORKER_ASSIGNED", "Worker must be reset before reassignment")
   // Verify the desired assignment independently; a control request cannot make
   // the journal claim ownership which the gateway no longer recognizes.
   const remote = await gateway(`/internal/v1/workers/${workerId}/assignment`, undefined, "GET")
   if (remote.assignment?.id !== body.assignmentId || remote.assignment?.tenantId !== body.tenantId || remote.assignment?.fence !== body.fence) throw managedError(409, "STALE_ASSIGNMENT", "Gateway assignment does not match")
   const result = { assigned: true, assignmentId: body.assignmentId, fence: body.fence }
   await journal.update((next) => {
    next.assignment = { id: body.assignmentId, tenantId: body.tenantId, fence: body.fence }; next.state = "assigned"
    next.operations[body.operationId] = { hash: fingerprint(body), result, at: now() }
   })
   void heartbeat()
   return result
  })
 }
 async function qrSnapshot() {
  const data = connection.getQrStatus()
  const valid = data.qr && Date.parse(data.expiresAt) > now() && !data.connected
  const qr = valid ? data.qr : null
  const image = qr ? await require("qrcode").toDataURL(qr, { width: 360, margin: 4 }) : null
  const current = connection.getQrStatus()
  if (qr && (current.qr !== qr || current.connected || Date.parse(current.expiresAt) <= now())) return { ...current, qr: null, qrImage: null, generation: null }
  return { ...data, qr, qrImage: image,
   generation: qr ? createHash("sha256").update(qr).digest("hex").slice(0, 24) : null }
 }
 async function pairing(body) {
  return serializedControl(async () => {
   assertAssignment(body); operationState(snapshot(), body)
   if (body.fresh !== undefined && typeof body.fresh !== "boolean") throw managedError(400, "INVALID_FRESH", "fresh must be a boolean")
   const previous = snapshot().operations[body.operationId]
   if (!previous) {
    await journal.update((data) => { data.operations[body.operationId] = { hash: fingerprint(body), result: { requested: true }, at: now() } })
    await connection.startWhatsApp()
    await connection.requestQr({ fresh: body.fresh !== false, timeoutMs: 15000 })
   }
   assertAssignment(body)
   return qrSnapshot()
  })
 }
 async function reset(body) {
  return serializedControl(async () => {
   if (!ownershipConfirmed || !journal || stopped) throw managedError(503, "WORKER_QUARANTINED", "Worker ownership has not been confirmed")
   const previous = operationState(snapshot(), body)
   if (previous) {
    if (snapshot().assignment) throw managedError(409, "STALE_ASSIGNMENT", "Reset operation belongs to a previous assignment")
    return previous.result
   }
   assertAssignment(body, { allowDraining: true, allowQuarantined: true })
   await journal.update((data) => { data.state = "draining" })
   try {
    let timeout
    try { await Promise.race([executing || Promise.resolve(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Worker did not drain")), drainMs); timeout.unref?.() })]) }
    finally { if (timeout) clearTimeout(timeout) }
    if (typeof connection.resetWhatsApp !== "function") throw new Error("Connection does not support safe reset")
    await journal.update((data) => {
     for (const job of Object.values(data.jobs)) if (!TERMINAL.has(job.status)) {
      job.status = job.status === "sending" ? "unknown" : "cancelled"; job.updatedAt = now(); delete job.payload; delete job.media
      data.outbox.push(eventFor(job, job.status, { errorCode: job.status === "unknown" ? "AMBIGUOUS_SEND_OUTCOME" : "SESSION_RELEASED", retryable: false }))
     }
    })
    await connection.resetWhatsApp()
    await flush()
    if (snapshot().outbox.length) throw new Error("Previous customer reports are not yet acknowledged")
    const result = { clean: true, assignmentId: body.assignmentId, fence: body.fence }
    await journal.update((data) => {
     data.assignment = null; data.state = "unassigned"
     // Cloudflare acknowledged all outcomes and remote logout was confirmed.
     // Remove tenant journal residue before this server enters the clean pool.
     data.jobs = {}; data.operations = {}
     data.operations[body.operationId] = { hash: fingerprint(body), result, at: now() }
    })
    quarantineReason = null; ready = true
    void heartbeat(); void flush()
    return result
   } catch { await quarantine("RESET_FAILED"); throw managedError(503, "RESET_FAILED", "Worker cleanup could not be confirmed; worker quarantined") }
  })
 }
 function validateDispatch(body) {
  assertAssignment(body)
  for (const key of ["jobId", "attemptId"]) validId(body[key], key)
  fence(body.attemptFence)
  if (!Number.isSafeInteger(body.leaseExpiresAt) || body.leaseExpiresAt <= now() || body.leaseExpiresAt > now() + 300000) throw managedError(409, "LEASE_EXPIRED", "Dispatch lease is invalid or expired")
  if (!body.payload || typeof body.payload !== "object") throw managedError(400, "INVALID_PAYLOAD", "Message payload is required")
  const payload = { ...body.payload }
  if (body.media) {
   validId(body.media.mediaId)
   if (!/^[a-f0-9]{64}$/.test(body.media.sha256 || "") || !Number.isSafeInteger(body.media.size) || body.media.size < 1) throw managedError(400, "INVALID_MEDIA", "Media integrity metadata is required")
   payload.url = trustedMediaUrl(body.media.url)
  }
  try { return buildMessagePayload(payload) }
  catch (error) { throw managedError(error.status || 400, "INVALID_PAYLOAD", error.message) }
 }
 function trustedMediaUrl(value) {
  let url
  try { url = new URL(value) } catch { throw managedError(400, "INVALID_MEDIA_URL", "Invalid media download URL") }
  const origin = new URL(env.GATEWAY_URL || "https://gateway.invalid").origin
  const allowed = new Set([origin, ...(env.MEDIA_ALLOWED_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean)])
  if (!allowed.has(url.origin) || url.username || url.password || url.hash || (url.protocol !== "https:" && !options.allowLocalMedia)) throw managedError(400, "INVALID_MEDIA_URL", "Media download must use a gateway-owned origin")
  return url.href
 }
 async function dispatch(body) {
  assertReady()
  const existing = snapshot().jobs[body.jobId]
  const identity = fingerprint({ ...body, leaseExpiresAt: undefined, media: body.media ? { ...body.media, url: undefined } : undefined })
  const payloadIdentity = fingerprint({ tenantId: body.tenantId, assignmentId: body.assignmentId, assignmentFence: body.assignmentFence,
   payload: body.payload, media: body.media ? { ...body.media, url: undefined } : undefined })
  if (existing && existing.attemptId === body.attemptId) {
   assertAssignment(body)
   if (existing.identity !== identity) throw managedError(409, "JOB_CONFLICT", "Job ID was already dispatched with different parameters")
   return publicJob(existing)
  }
  if (existing && !(existing.status === "failed" && existing.retryable === true && body.attemptFence > existing.attemptFence && existing.payloadIdentity === payloadIdentity)) throw managedError(409, "JOB_CONFLICT", "Previous attempt cannot be retried")
  validateDispatch(body)
  if (Object.values(snapshot().jobs).filter((job) => !TERMINAL.has(job.status)).length >= 100) throw managedError(429, "WORKER_CAPACITY", "Worker admission capacity is full")
  await journal.update((data) => {
   if (data.state !== "assigned" || data.assignment?.id !== body.assignmentId || data.assignment?.tenantId !== body.tenantId || data.assignment?.fence !== body.assignmentFence) throw managedError(409, "STALE_ASSIGNMENT", "Assignment changed during admission")
   if (!data.jobs[body.jobId] && Object.values(data.jobs).filter((job) => !TERMINAL.has(job.status)).length >= 100) throw managedError(429, "WORKER_CAPACITY", "Worker admission capacity is full")
   if (data.jobs[body.jobId]) {
    const previous = data.jobs[body.jobId]
    if (previous.attemptId === body.attemptId) {
     if (previous.identity !== identity) throw managedError(409, "JOB_CONFLICT", "Job ID conflict")
     return
    }
    if (!(previous.status === "failed" && previous.retryable === true && body.attemptFence > previous.attemptFence && previous.payloadIdentity === payloadIdentity)) throw managedError(409, "JOB_CONFLICT", "Previous attempt cannot be retried")
   }
   data.jobs[body.jobId] = { ...body, identity, payloadIdentity, status: "admitted", createdAt: now(), updatedAt: now() }
  })
  kick()
  return publicJob(snapshot().jobs[body.jobId])
 }
 function publicJob(job) {
  return { jobId: job.jobId, attemptId: job.attemptId, status: job.status, ...(job.messageId ? { messageId: job.messageId } : {}), ...(job.errorCode ? { errorCode: job.errorCode } : {}) }
 }
 function kick() {
  if (executing || stopped || !ready || snapshot()?.state === "draining") return
  const job = Object.values(snapshot().jobs).find((item) => item.status === "admitted")
  if (!job) return
  executing = execute(job).catch(() => quarantine("JOURNAL_WRITE_FAILED")).finally(() => { executing = null; kick() })
 }
 async function execute(job) {
  let staged, stream, marked = false
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), sendTimeoutMs)
  deadline.unref?.()
  let renewing = false
  const leaseTimer = setInterval(() => {
   if (renewing || controller.signal.aborted) return
   renewing = true
   gateway(`/internal/v1/jobs/${job.jobId}/lease`, { assignmentId: job.assignmentId, assignmentFence: job.assignmentFence,
    attemptId: job.attemptId, attemptFence: job.attemptFence }).then(async (grant) => {
     if (!Number.isSafeInteger(grant.leaseExpiresAt) || grant.leaseExpiresAt <= now() || grant.leaseExpiresAt > now() + 300000) throw new Error("Invalid renewed lease")
     job.leaseExpiresAt = grant.leaseExpiresAt
     await journal.update((data) => { const current = data.jobs[job.jobId]; if (current?.attemptId === job.attemptId && !TERMINAL.has(current.status)) current.leaseExpiresAt = grant.leaseExpiresAt })
    }).catch(() => { if (job.leaseExpiresAt <= now()) controller.abort(managedError(409, "LEASE_EXPIRED", "Execution lease expired")) })
    .finally(() => { renewing = false })
  }, 15000)
  leaseTimer.unref?.()
  try {
   assertAssignment(job)
   await journal.update((data) => { data.jobs[job.jobId].status = "processing"; data.jobs[job.jobId].updatedAt = now() })
   const built = validateDispatch(job)
   if (built.media) {
    staged = await staging.stage(built.media, { signal: controller.signal })
    const sha256 = await fileHash(staged.path)
    if (!job.media || staged.size !== job.media.size || sha256 !== job.media.sha256) throw managedError(415, "MEDIA_INTEGRITY_FAILED", "Media integrity validation failed")
   }
   const pause = nextSendAt - now()
   if (pause > 0) await require("node:timers/promises").setTimeout(pause, undefined, { signal: controller.signal })
   controller.signal.throwIfAborted()
   assertAssignment(job)
   const sock = connection.getSocket()
   if (!sock) throw managedError(503, "WHATSAPP_DISCONNECTED", "WhatsApp is not connected")
   const messageId = generateMessageId(sock)
   const authorization = await gateway(`/internal/v1/jobs/${job.jobId}/send-start`, {
    eventId: `${job.attemptId}-send-start`, assignmentId: job.assignmentId, assignmentFence: job.assignmentFence,
    attemptId: job.attemptId, attemptFence: job.attemptFence, messageId
   })
   if (authorization.authorized !== true || !Number.isSafeInteger(authorization.authorizationExpiresAt) || authorization.authorizationExpiresAt <= now() ||
       !Number.isSafeInteger(authorization.leaseExpiresAt) || authorization.leaseExpiresAt <= now()) throw managedError(409, "SEND_NOT_AUTHORIZED", "Gateway did not authorize sending")
   controller.signal.throwIfAborted()
   assertAssignment(job)
   await journal.update((data) => { const item = data.jobs[job.jobId]; item.status = "sending"; item.messageId = messageId; item.updatedAt = now() })
   marked = true
   controller.signal.throwIfAborted()
   assertAssignment(job)
   if (authorization.authorizationExpiresAt <= now() || authorization.leaseExpiresAt <= now() || connection.getSocket() !== sock) throw new Error("Send authorization expired")
   const content = structuredClone(built.content)
   if (staged) {
    stream = staged.open(); stream.on("error", () => {})
    content[built.media.kind] = { stream }; content.mimetype = staged.mimetype
    if (built.media.kind === "sticker") content.isAnimated = staged.metadata.animated
    if (built.media.kind === "audio" && content.seconds === undefined) content.seconds = Math.ceil(staged.metadata.duration)
   }
   nextSendAt = now() + minIntervalMs
   const timeout = new Promise((_, reject) => {
    if (controller.signal.aborted) return reject(new Error("Send timed out"))
    controller.signal.addEventListener("abort", () => reject(new Error("Send timed out")), { once: true })
   })
   const result = await Promise.race([sock.sendMessage(built.jid, content, { messageId, mediaUploadTimeoutMs: 60000 }), timeout])
   if (!result?.key?.id || result.key.id !== messageId) throw new Error("Send result has no matching identifier")
   await complete(job.jobId, "sent", { messageId })
  } catch (error) {
   const current = snapshot().jobs[job.jobId]
   if (!RANK[current?.status]) await complete(job.jobId, marked ? "unknown" : "failed", { errorCode: marked ? "AMBIGUOUS_SEND_OUTCOME" : safeError(error), retryable: !marked && ["WHATSAPP_DISCONNECTED", "GATEWAY_UNAVAILABLE", "LEASE_EXPIRED", "SEND_NOT_AUTHORIZED"].includes(error.code) })
   if (marked && !RANK[snapshot().jobs[job.jobId]?.status]) await quarantine("AMBIGUOUS_SEND_OUTCOME")
  } finally {
   clearTimeout(deadline)
   clearInterval(leaseTimer)
   if (stream) await new Promise((resolve) => { if (stream.closed) return resolve(); stream.once("close", resolve); stream.destroy() })
   await staged?.cleanup()
  }
 }
 async function fileHash(filename) {
  const hash = createHash("sha256")
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk)
  return hash.digest("hex")
 }
 function inspect(body, importing = false) {
  return serializedControl(() => inspectMedia(body, importing))
 }
 async function inspectMedia(body, importing = false) {
  assertAssignment(body); validId(body.operationId); validId(body.mediaId)
  if (!Object.hasOwn(MEDIA_LIMITS, body.type)) throw managedError(400, "INVALID_MEDIA_TYPE", "Unsupported media type")
  if (importing) {
   let source
   try { source = new URL(body.url) } catch { throw managedError(400, "INVALID_MEDIA_URL", "Invalid source URL") }
   if (source.protocol !== "https:") throw managedError(400, "INVALID_MEDIA_URL", "Media imports require HTTPS")
  }
  const url = importing ? body.url : trustedMediaUrl(body.url)
  // Download grants are short lived. Reissuing one must not change the identity
  // of an inspection of the same immutable media object.
  const operationBody = importing ? body : { ...body, url: undefined }
  const previous = operationState(snapshot(), operationBody)
  if (previous?.result) return previous.result
  let staged
  try {
   const built = buildMessagePayload({ phone: "12025550123", type: body.type, url, ...(body.mimetype ? { mimetype: body.mimetype } : {}) })
   staged = await staging.stage(built.media, { signal: AbortSignal.timeout(90000) })
   const sha256 = await fileHash(staged.path)
   if ((body.expectedSize !== undefined && body.expectedSize !== staged.size) || (body.expectedSha256 !== undefined && body.expectedSha256 !== sha256)) throw managedError(415, "MEDIA_INTEGRITY_FAILED", "Media integrity validation failed")
   assertAssignment(body)
   const result = { success: true, mediaId: body.mediaId, size: staged.size, sha256, mimetype: staged.mimetype, metadata: staged.metadata }
   if (importing) {
    const grant = await gateway(`/internal/v1/media/${body.mediaId}/import-target`, { assignmentId: body.assignmentId, fence: body.fence, size: staged.size, mimetype: staged.mimetype, sha256 })
    const parts = grant.mode === "multipart" ? grant.parts : [{ url: grant.url, headers: grant.headers, start: 0, size: staged.size }]
    if (!Array.isArray(parts) || !parts.length || parts.length > 20 || parts.reduce((sum, part) => sum + part.size, 0) !== staged.size) throw new Error("Invalid media upload grant")
    let offset = 0, response
    for (const part of parts) {
     const destination = new URL(part.url)
     if (destination.protocol !== "https:" || destination.username || destination.password || part.start !== offset || !Number.isSafeInteger(part.size) || part.size <= 0) throw new Error("Invalid media upload grant")
     assertAssignment(body)
     response = await (options.fetchImpl || fetch)(destination, { method: "PUT", headers: { ...part.headers, "content-length": String(part.size) }, body: fs.createReadStream(staged.path, { start: offset, end: offset + part.size - 1 }), duplex: "half", redirect: "error", signal: AbortSignal.timeout(90000) })
     if (!response.ok) throw new Error("Media upload failed")
     await response.body?.cancel()
     offset += part.size
    }
    const eventId = body.operationId
    await journal.update((data) => { data.outbox.push({ path: `/internal/v1/media/${body.mediaId}/result`, body: { eventId, assignmentId: body.assignmentId, fence: body.fence, success: true, ...result, etag: response.headers.get("etag") }, createdAt: now() }) })
    void flush()
   }
   await journal.update((data) => { data.operations[body.operationId] = { hash: fingerprint(operationBody), result, at: now() } })
   return result
  } catch (error) {
   if (importing) {
    await journal.update((data) => { data.outbox.push({ path: `/internal/v1/media/${body.mediaId}/result`, body: { eventId: `${body.operationId}-failed`, assignmentId: body.assignmentId, fence: body.fence, success: false, errorCode: safeError(error, "MEDIA_IMPORT_FAILED") }, createdAt: now() }) })
    void flush()
   }
   throw error
  } finally { await staged?.cleanup() }
 }
 function shutdown() {
  if (shutdownPromise) return shutdownPromise
  stopped = true; ready = false; clearInterval(timer)
  shutdownPromise = (async () => {
   let timeout
   await Promise.race([executing || Promise.resolve(), new Promise((resolve) => { timeout = setTimeout(resolve, drainMs) })])
   clearTimeout(timeout)
   await connection.stopWhatsApp()
   // An in-flight call may resolve after shutdown. Keep its journal open until
   // completion; a forced process exit is reconciled from durable send intent.
   if (executing) await executing
   await control
   unsubscribeUpdates?.()
   await staging.shutdown()
   await journal?.close()
  })()
  return shutdownPromise
 }
 return { workerId, secret, config: { drainMs }, capabilities, start: bootWorker, assign, pairing, reset, dispatch, inspect,
  qr(body) { assertAssignment(body); return qrSnapshot() },
  job(id, body) { assertAssignment(body); validId(id); const job = snapshot().jobs[id]; return job && job.assignmentId === body.assignmentId ? publicJob(job) : null },
  readiness: () => ({ ready: ready && !stopped && snapshot()?.state !== "quarantined", state: quarantineReason || snapshot()?.state || "bootstrapping" }),
  getConnectionStatus: connection.getConnectionStatus, heartbeat, flush, shutdown,
  debugSnapshot: () => snapshot() }
}
module.exports = { createManagedWorker }
