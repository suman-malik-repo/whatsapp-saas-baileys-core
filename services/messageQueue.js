const { randomUUID } = require("node:crypto")
const { loadQueueConfig } = require("../config/queue")

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/
const ACK_RANK = { sent: 1, delivered: 2, read: 3 }
const FINISHED = new Set(["sent", "delivered", "read", "failed", "cancelled", "unknown"])
const newMetrics = () => ({ successfulSends: 0, failedJobs: 0, cancelledJobs: 0, unknownJobs: 0, attempts: 0, totalWaitMs: 0, startedJobs: 0, cleanupFailures: 0 })

function queueError(code, status = 503, message = "Message queue is unavailable") {
 return Object.assign(new Error(message), { code, status, expose: true })
}

function createMessageQueue(options = {}) {
 if (typeof options.processJob !== "function") throw new TypeError("processJob is required")
 const config = loadQueueConfig({}, options.config || {})
 const clock = options.now || Date.now
 const random = options.random || Math.random
 const setTimer = options.setTimer || setTimeout
 const clearTimer = options.clearTimer || clearTimeout
 const jobs = new Map()
 const reservations = new Map()
 const sessions = new Map()
 const messageIds = new Map()
 const earlyAcks = new Map()
 const waiters = new Set()
 const metrics = newMetrics()
 let slots = 0
 let timer = null
 let scheduled = false
 let accepting = true
 let closing = false
 let stopped = false
 let shutdownPromise = null
 let executing = 0
 const drainWaiters = new Set()

 function timestamp(value) { return value === null || value === undefined ? null : new Date(value).toISOString() }
 function safeCode(error, fallback) { return typeof error?.code === "string" && ERROR_CODE.test(error.code) ? error.code : fallback }
 function validId(value, label) {
  if (typeof value !== "string" || !ID.test(value)) throw queueError("INVALID_JOB_ID", 400, `${label} must contain 1 to 128 letters, numbers, underscores or hyphens`)
  return value
 }
 function getSession(id = "default") {
  validId(id, "Session ID")
  if (!sessions.has(id)) {
   if (sessions.size >= config.maxSessions) throw queueError("SESSION_LIMIT", 503)
   sessions.set(id, { id, pending: [], active: new Set(), tokens: config.burstCapacity, refillAt: clock(), lastAttemptAt: null, connection: { state: "stopped", connected: false }, permanentAuthentication: false, metrics: newMetrics() })
  }
  return sessions.get(id)
 }
 function snapshot(job) {
  const result = {
   jobId: job.jobId, sessionId: job.sessionId, status: job.status, attempts: job.attempts,
   createdAt: timestamp(job.createdAt), updatedAt: timestamp(job.updatedAt),
   startedAt: timestamp(job.startedAt), completedAt: timestamp(job.completedAt)
  }
  for (const name of ["sentAt", "deliveredAt", "readAt"]) if (job[name] !== null) result[name] = timestamp(job[name])
  if (job.nextAttemptAt !== null) result.nextAttemptAt = timestamp(job.nextAttemptAt)
  if (job.messageId) result.messageId = job.messageId
  if (job.error) result.error = { ...job.error }
  return result
 }
 function state(job, status) {
  job.status = status
  job.updatedAt = clock()
 }
 function count(job, name, amount = 1) {
  metrics[name] += amount
  sessions.get(job.sessionId).metrics[name] += amount
 }
 function success(job) {
  if (job.successCounted) return
  job.successCounted = true
  count(job, "successfulSends")
 }
 function notify(job) {
  if (!FINISHED.has(job.status)) return
  for (const waiter of [...waiters]) {
   if (waiter.jobId === job.jobId) {
    waiters.delete(waiter)
    clearTimer(waiter.timer)
    waiter.resolve(snapshot(job))
   }
  }
 }
 function removePending(job) {
  const pending = sessions.get(job.sessionId)?.pending
  const index = pending?.indexOf(job.jobId) ?? -1
  if (index !== -1) pending.splice(index, 1)
 }
 function forget(job) {
  jobs.delete(job.jobId)
  for (const messageId of job.messageIds) messageIds.delete(`${job.sessionId}\0${messageId}`)
 }
 function prune() {
  const time = clock()
  for (const [key, ack] of earlyAcks) if (ack.expiresAt <= time) earlyAcks.delete(key)
  const completed = [...jobs.values()].filter(job => job.cleaned && !job.execution).sort((a, b) => a.completedAt - b.completedAt)
  for (const job of completed) if (job.completedAt + config.statusTtlMs <= time) forget(job)
  const retained = completed.filter(job => jobs.has(job.jobId))
  for (let index = 0; index < retained.length - config.statusRetention; index++) forget(retained[index])
 }
 function finish(job, status, error = null) {
  if (job.finalizing) return job.finalizing
  removePending(job)
  state(job, status)
  job.nextAttemptAt = null
  job.error = error
  job.completedAt = clock()
  if (status === "sent" || status === "delivered" || status === "read") {
   if (job.sentAt === null) job.sentAt = clock()
   success(job)
  } else if (status === "failed") count(job, "failedJobs")
  else if (status === "cancelled") count(job, "cancelledJobs")
  else if (status === "unknown") count(job, "unknownJobs")
  // Cleanup owns staged resources. Keep its admission slot until it completes.
  job.finalizing = Promise.resolve().then(() => job.cleanup?.()).catch(() => {
   count(job, "cleanupFailures")
  }).then(() => {
   job.payload = null
   job.metadata = null
   job.recipient = null
   job.cleanup = null
   job.cleaned = true
   if (!job.execution) releaseSlot(job)
   notify(job)
   prune()
   kick()
  })
  return job.finalizing
 }
 function releaseSlot(job) {
  if (!job.slotHeld) return
  job.slotHeld = false
  slots--
 }
 function refill(session) {
  const time = clock()
  const elapsed = Math.max(0, time - session.refillAt)
  session.tokens = Math.min(config.burstCapacity, session.tokens + elapsed * config.refillPerSecond / 1000)
  session.refillAt = time
 }
 function pacingTime(session) {
  refill(session)
  const interval = session.lastAttemptAt === null ? clock() : session.lastAttemptAt + config.minIntervalMs
  const token = session.tokens >= 1 ? clock() : clock() + Math.ceil((1 - session.tokens) * 1000 / config.refillPerSecond)
  return Math.max(interval, token)
 }
 function acknowledge(job, status) {
  if (["failed", "cancelled"].includes(job.status)) return false
  if ((ACK_RANK[job.status] || 0) >= ACK_RANK[status]) return false
  if (!job.messageId) return false
  state(job, status)
  success(job)
  job.error = null
  if (job.sentAt === null) job.sentAt = clock()
  if (ACK_RANK[status] >= 2 && job.deliveredAt === null) job.deliveredAt = clock()
  if (status === "read" && job.readAt === null) job.readAt = clock()
  if (job.cleaned) notify(job)
  return true
 }
 function registerId(job, messageId) {
  if (typeof messageId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(messageId)) return
  const key = `${job.sessionId}\0${messageId}`
  const owner = messageIds.get(key)
  if (owner && owner !== job.jobId) throw queueError("DUPLICATE_MESSAGE_ID", 409)
  job.messageId = messageId
  job.messageIds.add(messageId)
  messageIds.set(key, job.jobId)
  const ack = earlyAcks.get(key)
  if (ack) {
   earlyAcks.delete(key)
   if (ack.expiresAt > clock()) acknowledge(job, ack.status)
  }
 }
 function retry(job, error) {
  const exponent = Math.min(job.attempts - 1, 30)
  const base = Math.min(config.retryMaxMs, config.retryBaseMs * 2 ** exponent)
  const unitRandom = Math.max(0, Math.min(1, Number(random()) || 0))
  const delay = Math.min(config.retryMaxMs, Math.max(1, Math.round(base * (1 + config.retryJitter * (2 * unitRandom - 1)))))
  state(job, "retry_wait")
  job.nextAttemptAt = clock() + delay
  job.error = { code: safeCode(error, "TEMPORARY_FAILURE"), retryable: true }
  sessions.get(job.sessionId).pending.unshift(job.jobId)
 }
 function timeoutExecution(job) {
  const execution = job.execution
  if (!execution || execution.finished || execution.timedOut) return
  execution.timedOut = true
  execution.deadlineAt = null
  execution.controller.abort()
  if (ACK_RANK[job.status]) void finish(job, job.status)
  else void finish(job, execution.marked ? "unknown" : "failed", { code: execution.marked ? "AMBIGUOUS_SEND_OUTCOME" : "PROCESSING_TIMEOUT", retryable: false })
 }
 function dispatch(job, session) {
  session.active.add(job.jobId)
  session.tokens -= 1
  session.lastAttemptAt = clock()
  job.attempts++
  count(job, "attempts")
  if (job.startedAt === null) {
   job.startedAt = clock()
   count(job, "totalWaitMs", Math.max(0, clock() - job.createdAt))
   count(job, "startedJobs")
  }
  state(job, "processing")
  job.nextAttemptAt = null
  job.error = null
  const execution = { controller: new AbortController(), deadlineAt: clock() + config.jobTimeoutMs, marked: false, finished: false, timedOut: false, disconnected: false }
  job.execution = execution
  executing++
  const markSending = (messageId) => {
   if (execution.finished || execution.timedOut || execution.controller.signal.aborted || !session.connection.connected || session.permanentAuthentication) {
    const error = queueError("CONNECTION_UNAVAILABLE", 503)
    error.safeToRetry = !session.permanentAuthentication
    error.permanentAuthentication = session.permanentAuthentication
    throw error
   }
   if (execution.marked) throw queueError("SEND_ALREADY_STARTED", 409)
   // Register before sendMessage so acknowledgements that race its Promise are retained.
   registerId(job, messageId)
   execution.marked = true
   return true
  }
  const context = { signal: execution.controller.signal, markSending }
  const privateJob = {
   jobId: job.jobId, sessionId: job.sessionId, recipient: job.recipient,
   metadata: job.metadata, payload: job.payload, attempts: job.attempts,
   createdAt: timestamp(job.createdAt)
  }
  Promise.resolve().then(() => options.processJob(privateJob, context)).then(result => {
   if (execution.timedOut || closing && job.finalizing) {
    if (execution.marked && result?.messageId) {
     registerId(job, result.messageId)
     acknowledge(job, "sent")
    }
    return
   }
   registerId(job, result?.messageId)
   void finish(job, ACK_RANK[job.status] ? job.status : "sent")
  }, error => {
   if (execution.timedOut || job.finalizing) return
   if (error?.permanentAuthentication && !session.permanentAuthentication) {
    setConnection(job.sessionId, { state: "logged_out", connected: false, permanentAuthentication: true })
   }
   if (ACK_RANK[job.status]) {
    void finish(job, job.status)
   } else if (execution.marked) {
    void finish(job, "unknown", { code: "AMBIGUOUS_SEND_OUTCOME", retryable: false })
   } else if (error?.permanentAuthentication || session.permanentAuthentication) {
    setConnection(job.sessionId, { state: "logged_out", connected: false, permanentAuthentication: true })
    void finish(job, "failed", { code: "AUTHENTICATION_REQUIRED", retryable: false })
   } else if ((error?.safeToRetry === true || execution.disconnected && error?.safeToRetry !== false) && ![400, 413, 415, 422].includes(error?.status) && !closing && job.attempts <= config.maxRetries && clock() < job.createdAt + config.maxJobAgeMs) {
    retry(job, error)
   } else {
    void finish(job, closing ? "cancelled" : "failed", { code: safeCode(error, closing ? "WORKER_SHUTDOWN" : "PROCESSING_FAILED"), retryable: false })
   }
  }).catch(() => {
   if (!job.finalizing) void finish(job, execution.marked ? "unknown" : "failed", { code: execution.marked ? "AMBIGUOUS_SEND_OUTCOME" : "PROCESSING_FAILED", retryable: false })
  }).finally(() => {
   execution.finished = true
   execution.deadlineAt = null
   if (job.execution === execution) job.execution = null
   session.active.delete(job.jobId)
   executing--
   if (job.cleaned) releaseSlot(job)
   if (executing === 0) for (const resolve of [...drainWaiters]) resolve()
   prune()
   kick()
  })
 }
 function pump() {
  scheduled = false
  if (timer !== null) clearTimer(timer)
  timer = null
  if (stopped) return
  prune()
  const time = clock()
  for (const [id, reservation] of reservations) {
   if (reservation.expiresAt <= time) {
    reservations.delete(id)
    slots--
   }
  }
  for (const job of jobs.values()) {
   if (["queued", "retry_wait"].includes(job.status) && job.createdAt + config.maxJobAgeMs <= time) {
    void finish(job, "failed", { code: "JOB_EXPIRED", retryable: false })
   }
   if (job.execution?.deadlineAt !== null && job.execution?.deadlineAt <= time) timeoutExecution(job)
  }
  if (!closing) {
   for (const session of sessions.values()) {
    while (session.connection.connected && !session.permanentAuthentication && session.active.size < config.concurrency && session.pending.length) {
     const job = jobs.get(session.pending[0])
     if (!job || !["queued", "retry_wait"].includes(job.status)) { session.pending.shift(); continue }
     if (job.execution || (job.nextAttemptAt !== null && job.nextAttemptAt > time) || pacingTime(session) > time) break
     session.pending.shift()
     dispatch(job, session)
    }
   }
  }
  armTimer()
 }
 function armTimer() {
  if (stopped) return
  let next = Infinity
  const time = clock()
  for (const reservation of reservations.values()) next = Math.min(next, reservation.expiresAt)
  for (const ack of earlyAcks.values()) next = Math.min(next, ack.expiresAt)
  for (const job of jobs.values()) {
   if (["queued", "retry_wait"].includes(job.status)) next = Math.min(next, job.createdAt + config.maxJobAgeMs)
   if (job.execution?.deadlineAt !== null && job.execution?.deadlineAt !== undefined) next = Math.min(next, job.execution.deadlineAt)
   if (job.cleaned && !job.execution) next = Math.min(next, job.completedAt + config.statusTtlMs)
  }
  if (!closing) for (const session of sessions.values()) {
   const head = jobs.get(session.pending[0])
   if (session.connection.connected && !session.permanentAuthentication && session.active.size < config.concurrency && head && !head.execution) {
    next = Math.min(next, Math.max(head.nextAttemptAt || time, pacingTime(session)))
   }
  }
  if (Number.isFinite(next)) {
   timer = setTimer(pump, Math.max(1, Math.min(2147483647, Math.ceil(next - time))))
   timer?.unref?.()
  }
 }
 function kick() {
  if (scheduled || stopped) return
  scheduled = true
  queueMicrotask(pump)
 }
 function reserve({ sessionId = "default", jobId = randomUUID() } = {}) {
  prune()
  validId(jobId, "Job ID")
  if (!accepting) throw queueError("WORKER_SHUTTING_DOWN", 503, "Message worker is shutting down")
  const session = getSession(sessionId)
  if (session.permanentAuthentication) throw queueError("AUTHENTICATION_REQUIRED", 503, "WhatsApp session requires authentication")
  if (jobs.has(jobId) || reservations.has(jobId)) throw queueError("DUPLICATE_JOB_ID", 409, "Job ID already exists")
  if (slots >= config.maxPending) throw queueError("QUEUE_FULL", 429, "Message queue is full; retry later")
  const reservation = { jobId, sessionId, createdAt: clock(), expiresAt: clock() + config.stagingTtlMs }
  reservations.set(jobId, reservation)
  slots++
  kick()
  return {
   jobId,
   commit({ recipient, metadata = {}, payload, cleanup } = {}) {
    if (reservations.get(jobId) !== reservation || !accepting || reservation.expiresAt <= clock() || session.permanentAuthentication) {
     release()
     throw queueError("ADMISSION_EXPIRED", 503, "Message admission expired or worker became unavailable")
    }
    if (typeof recipient !== "string" || !recipient || recipient.length > 128 || /[\x00-\x1f\x7f]/.test(recipient)) throw queueError("INVALID_RECIPIENT", 400, "A valid recipient is required")
    if (cleanup !== undefined && typeof cleanup !== "function") throw new TypeError("cleanup must be a function")
    let encoded
    try { encoded = JSON.stringify({ metadata, payload }) } catch { throw queueError("INVALID_PAYLOAD", 400, "Queue payload must be JSON serializable") }
    if (encoded === undefined || Buffer.byteLength(encoded) > config.payloadMaxBytes) throw queueError("PAYLOAD_TOO_LARGE", 413, "Queue payload is too large")
    reservations.delete(jobId)
    const time = clock()
    const job = {
     jobId, sessionId, recipient, metadata, payload, cleanup,
     status: "queued", attempts: 0, createdAt: reservation.createdAt, updatedAt: time,
     startedAt: null, completedAt: null, sentAt: null, deliveredAt: null, readAt: null,
     nextAttemptAt: null, messageId: null, messageIds: new Set(), error: null, execution: null,
     finalizing: null, cleaned: false, slotHeld: true, successCounted: false
    }
    jobs.set(jobId, job)
    session.pending.push(jobId)
    kick()
    return snapshot(job)
   },
   release
  }
  function release() {
   if (reservations.get(jobId) !== reservation) return false
   reservations.delete(jobId)
   slots--
   kick()
   return true
  }
 }
 function enqueue(input = {}) {
  const reservation = reserve(input)
  try { return reservation.commit(input) } catch (error) { reservation.release(); throw error }
 }
 function setConnection(sessionId = "default", connection = {}) {
  const session = getSession(sessionId)
  session.connection = {
   connected: connection.connected === true,
   state: typeof connection.state === "string" && /^[a-z_]{1,40}$/.test(connection.state) ? connection.state : "disconnected"
  }
  session.permanentAuthentication = connection.permanentAuthentication === true || ["logged_out", "failed"].includes(session.connection.state)
  if (session.permanentAuthentication) session.connection.connected = false
  if (!session.connection.connected) {
   for (const jobId of session.active) {
    const execution = jobs.get(jobId)?.execution
    if (execution && !execution.marked) {
     execution.disconnected = true
     execution.controller.abort()
    }
   }
  }
  if (session.permanentAuthentication) {
   for (const jobId of [...session.pending]) {
    const job = jobs.get(jobId)
    if (job) void finish(job, "failed", { code: "AUTHENTICATION_REQUIRED", retryable: false })
   }
  }
  kick()
 }
 function updateAck({ messageId, status, sessionId = "default" } = {}) {
  if (typeof messageId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(messageId) || !ID.test(sessionId)) return false
  const normalized = ({ 2: "sent", 3: "delivered", 4: "read", 5: "read" })[status] || status
  if (!ACK_RANK[normalized]) return false
  prune()
  const key = `${sessionId}\0${messageId}`
  const job = jobs.get(messageIds.get(key))
  if (job) return acknowledge(job, normalized)
  const previous = earlyAcks.get(key)
  if (previous && ACK_RANK[previous.status] >= ACK_RANK[normalized]) return false
  earlyAcks.delete(key)
  earlyAcks.set(key, { status: normalized, expiresAt: clock() + config.earlyAckTtlMs })
  while (earlyAcks.size > config.earlyAckLimit) earlyAcks.delete(earlyAcks.keys().next().value)
  kick()
  return true
 }
 function getJob(jobId) {
  validId(jobId, "Job ID")
  prune()
  const job = jobs.get(jobId)
  return job ? snapshot(job) : null
 }
 function stats(sessionId) {
  if (sessionId !== undefined) validId(sessionId, "Session ID")
  prune()
  const selected = [...jobs.values()].filter(job => sessionId === undefined || job.sessionId === sessionId)
  const pending = selected.filter(job => ["queued", "retry_wait"].includes(job.status))
  const sessionList = [...sessions.values()].filter(session => sessionId === undefined || session.id === sessionId)
  const selectedMetrics = sessionId === undefined ? metrics : (sessions.get(sessionId)?.metrics || newMetrics())
  return {
   mode: "memory", durable: false, accepting, capacity: config.maxPending,
   occupiedSlots: sessionId === undefined ? slots : [...reservations.values()].filter(item => item.sessionId === sessionId).length + selected.filter(job => job.slotHeld).length,
   reservations: [...reservations.values()].filter(item => sessionId === undefined || item.sessionId === sessionId).length,
   pendingJobs: pending.length, activeJobs: sessionList.reduce((total, session) => total + session.active.size, 0),
   retryingJobs: pending.filter(job => job.status === "retry_wait").length,
   successfulSends: selectedMetrics.successfulSends, failedJobs: selectedMetrics.failedJobs, cancelledJobs: selectedMetrics.cancelledJobs,
   unknownOutcomeJobs: selectedMetrics.unknownJobs, attempts: selectedMetrics.attempts, cleanupFailures: selectedMetrics.cleanupFailures,
   averageWaitingMs: selectedMetrics.startedJobs ? Math.round(selectedMetrics.totalWaitMs / selectedMetrics.startedJobs) : 0,
   oldestPendingAgeMs: pending.length ? Math.max(...pending.map(job => Math.max(0, clock() - job.createdAt))) : 0,
   retainedStatuses: selected.length, earlyAcknowledgements: earlyAcks.size,
   sessions: sessionList.map(session => ({ sessionId: session.id, ...session.connection, pendingJobs: session.pending.length, activeJobs: session.active.size }))
  }
 }
 function waitForJob(jobId, timeoutMs = config.httpWaitMs) {
  const job = jobs.get(validId(jobId, "Job ID"))
  if (!job) return Promise.resolve(null)
  if (job.cleaned && FINISHED.has(job.status)) return Promise.resolve(snapshot(job))
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 60000) throw new TypeError("timeoutMs must be between 0 and 60000")
  if (timeoutMs === 0) return Promise.resolve(snapshot(job))
  if (waiters.size >= config.maxPending * 2) return Promise.reject(queueError("WAITER_LIMIT", 429))
  return new Promise(resolve => {
   const waiter = { jobId, resolve, timer: null }
   waiter.timer = setTimer(() => {
    waiters.delete(waiter)
    resolve(jobs.has(jobId) ? snapshot(jobs.get(jobId)) : null)
   }, timeoutMs)
   // A caller waiting on a job expects this timeout to keep its Promise live.
   waiters.add(waiter)
  })
 }
 function stopAdmission() { accepting = false }
 function shutdown({ drainMs = config.drainMs } = {}) {
  if (shutdownPromise) return shutdownPromise
  if (!Number.isFinite(drainMs) || drainMs < 0 || drainMs > 300000) throw new TypeError("drainMs must be between 0 and 300000")
  accepting = false
  closing = true
  for (const reservation of reservations.values()) slots--
  reservations.clear()
  const pendingCleanup = []
  for (const job of jobs.values()) if (["queued", "retry_wait"].includes(job.status)) {
   pendingCleanup.push(finish(job, "cancelled", { code: "WORKER_SHUTDOWN", retryable: false }))
  }
  shutdownPromise = (async () => {
   const deadline = clock() + drainMs
   let drainTimer = null
   let drained
   const activeDrain = new Promise(resolve => {
    drained = resolve
    if (executing === 0 || drainMs === 0) resolve()
    else {
     drainWaiters.add(resolve)
     drainTimer = setTimer(resolve, drainMs)
    }
   })
   await activeDrain
   drainWaiters.delete(drained)
   if (drainTimer !== null) clearTimer(drainTimer)
   for (const job of jobs.values()) if (job.execution && !job.finalizing) {
    job.execution.timedOut = true
    job.execution.deadlineAt = null
    job.execution.controller.abort()
    pendingCleanup.push(finish(job, ACK_RANK[job.status] ? job.status : job.execution.marked ? "unknown" : "cancelled", ACK_RANK[job.status] ? null : { code: job.execution.marked ? "AMBIGUOUS_SEND_OUTCOME" : "WORKER_SHUTDOWN", retryable: false }))
   }
   // Cleanup itself may depend on an uncooperative external resource; shutdown remains bounded.
   const cleanupPromises = [...new Set([...pendingCleanup,
    ...[...jobs.values()].map(job => job.finalizing).filter(Boolean)])]
   let cleanupTimer = null
   await Promise.race([
    Promise.allSettled(cleanupPromises),
    new Promise(resolve => { cleanupTimer = setTimer(resolve, Math.max(0, Math.min(1000, deadline - clock()))) })
   ])
   if (cleanupTimer !== null) clearTimer(cleanupTimer)
   stopped = true
   if (timer !== null) clearTimer(timer)
   timer = null
   earlyAcks.clear()
   for (const waiter of [...waiters]) {
    clearTimer(waiter.timer)
    waiter.resolve(jobs.has(waiter.jobId) ? snapshot(jobs.get(waiter.jobId)) : null)
   }
   waiters.clear()
   return stats()
  })()
  kick()
  return shutdownPromise
 }

 return { reserve, enqueue, getJob, stats, updateAck, setConnection, waitForJob, stopAdmission, shutdown, config }
}

module.exports = { createMessageQueue }
