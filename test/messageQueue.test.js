const assert = require("node:assert/strict")
const test = require("node:test")
const { loadQueueConfig } = require("../config/queue")
const { createMessageQueue } = require("../services/messageQueue")

function deferred() {
 let resolve, reject
 const promise = new Promise((yes, no) => { resolve = yes; reject = no })
 return { promise, resolve, reject }
}
async function flush() { for (let index = 0; index < 30; index++) await Promise.resolve() }
function fakeClock() {
 let time = 0
 let sequence = 0
 const timers = new Map()
 return {
  now: () => time,
  setTimer(callback, delay) {
   const timer = { id: ++sequence, due: time + delay, callback, unref() {} }
   timers.set(timer.id, timer)
   return timer
  },
  clearTimer(timer) { timers.delete(timer?.id) },
  async advance(milliseconds) {
   const end = time + milliseconds
   await flush()
   let iterations = 0
   while (true) {
    const next = [...timers.values()].filter(timer => timer.due <= end).sort((a, b) => a.due - b.due || a.id - b.id)[0]
    if (!next) break
    assert.ok(++iterations < 10000, "timer loop must remain bounded")
    time = next.due
    timers.delete(next.id)
    next.callback()
    await flush()
   }
   time = end
   await flush()
  },
  count: () => timers.size
 }
}
function fixture(t, processJob, config = {}) {
 const clock = fakeClock()
 const queue = createMessageQueue({
  processJob, config: { minIntervalMs: 0, burstCapacity: 100, refillPerSecond: 100,
   jobTimeoutMs: 1000, maxJobAgeMs: 10000, statusTtlMs: 1000, earlyAckTtlMs: 1000,
   retryBaseMs: 100, retryMaxMs: 1000, retryJitter: 0, ...config }, ...clock
 })
 queue.setConnection("default", { state: "connected", connected: true })
 t.after(async () => { await queue.shutdown({ drainMs: 0 }); assert.equal(clock.count(), 0) })
 const enqueue = (jobId, rest = {}) => queue.enqueue({ jobId, recipient: "12025550123", payload: { text: "private" }, ...rest })
 return { queue, clock, enqueue }
}

test("queue configuration has conservative defaults and rejects malformed or inconsistent settings", () => {
 const config = loadQueueConfig({})
 assert.equal(config.concurrency, 1)
 assert.equal(config.minIntervalMs, 1000)
 assert.equal(config.maxPending, 100)
 assert.equal(config.maxUploads, 1)
 assert.equal(config.apiMode, "queued")
 assert.equal(config.stagingMaxBytes, 268435456)
 assert.ok(Object.isFrozen(config))
 assert.equal(loadQueueConfig({ QUEUE_REFILL_PER_SECOND: "0.5", QUEUE_MAX_RETRIES: "0" }).refillPerSecond, 0.5)
 assert.equal(loadQueueConfig({ QUEUE_CONCURRENCY: "2" }, { concurrency: 3 }).concurrency, 3)
 for (const raw of ["", " 1", "1 ", "-1", "1e2", "01", "Infinity", "NaN", "1.5", true, null]) {
  assert.throws(() => loadQueueConfig({ QUEUE_MAX_PENDING: raw }), /QUEUE_MAX_PENDING/)
 }
 assert.throws(() => loadQueueConfig({}, { unknown: 1 }), /Unknown/)
 assert.throws(() => loadQueueConfig({}, { retryBaseMs: 2000, retryMaxMs: 1000 }), /QUEUE_RETRY_MAX_MS/)
 assert.throws(() => loadQueueConfig({}, { stagingTtlMs: 1000 }), /QUEUE_STAGING_TTL_MS/)
 assert.throws(() => loadQueueConfig({ QUEUE_API_MODE: "sync" }), /QUEUE_API_MODE/)
})

test("FIFO jobs execute once and default concurrency allows one active send per session", async t => {
 const gates = [deferred(), deferred(), deferred()]
 const started = []
 let active = 0
 const { queue, enqueue } = fixture(t, async (job, { markSending }) => {
  started.push(job.jobId)
  assert.equal(++active, 1)
  markSending(`WA_${job.jobId}`)
  await gates[started.length - 1].promise
  active--
  return { messageId: `WA_${job.jobId}` }
 })
 const first = enqueue("first")
 enqueue("second")
 enqueue("third")
 assert.equal(first.status, "queued")
 await flush()
 assert.deepEqual(started, ["first"])
 gates[0].resolve()
 await flush()
 assert.deepEqual(started, ["first", "second"])
 gates[1].resolve()
 await flush()
 gates[2].resolve()
 await flush()
 assert.deepEqual(started, ["first", "second", "third"])
 assert.equal(queue.getJob("third").status, "sent")
 assert.equal(queue.stats().successfulSends, 3)
 assert.equal(queue.stats().occupiedSlots, 0)
})

test("independent sessions make progress concurrently and retain their own FIFO order", async t => {
 const gate = deferred()
 const started = []
 const { queue, enqueue } = fixture(t, async job => {
  started.push(`${job.sessionId}:${job.jobId}`)
  await gate.promise
  return { messageId: job.jobId }
 })
 queue.setConnection("other", { state: "connected", connected: true })
 enqueue("a")
 enqueue("b")
 enqueue("c", { sessionId: "other" })
 enqueue("d", { sessionId: "other" })
 await flush()
 assert.deepEqual(started, ["default:a", "other:c"])
 assert.equal(queue.stats().activeJobs, 2)
 gate.resolve()
 await flush()
 assert.deepEqual(started, ["default:a", "other:c", "default:b", "other:d"])
})

test("configured concurrency is bounded and dispatch remains FIFO", async t => {
 const gate = deferred()
 const started = []
 const { queue, enqueue } = fixture(t, async job => { started.push(job.jobId); await gate.promise }, { concurrency: 2 })
 for (let number = 1; number <= 4; number++) enqueue(`job${number}`)
 await flush()
 assert.deepEqual(started, ["job1", "job2"])
 assert.equal(queue.stats().activeJobs, 2)
 gate.resolve()
 await flush()
 assert.deepEqual(started, ["job1", "job2", "job3", "job4"])
})

test("reservations enforce concurrent admission, reject duplicates, and release unused capacity", async t => {
 const { queue, enqueue } = fixture(t, async () => ({}), { maxPending: 2 })
 const reservation = queue.reserve({ jobId: "reserved" })
 assert.equal(queue.getJob("reserved"), null)
 assert.equal(queue.stats().reservations, 1)
 assert.throws(() => queue.reserve({ jobId: "reserved" }), error => error.status === 409 && error.code === "DUPLICATE_JOB_ID")
 enqueue("accepted")
 assert.throws(() => enqueue("overflow"), error => error.status === 429 && error.code === "QUEUE_FULL")
 assert.equal(reservation.release(), true)
 assert.equal(reservation.release(), false)
 assert.throws(() => reservation.commit({ recipient: "phone", payload: {} }), /admission expired/i)
 await flush()
 enqueue("replacement")
 await flush()
 assert.equal(queue.stats().occupiedSlots, 0)
 assert.throws(() => enqueue("accepted"), error => error.code === "DUPLICATE_JOB_ID")
})

test("cleanup holds its slot and runs exactly once before terminal waiters resolve", async t => {
 const cleanup = deferred()
 let calls = 0
 const { queue, enqueue } = fixture(t, async () => ({}), { maxPending: 1 })
 enqueue("cleanup", { cleanup: async () => { calls++; await cleanup.promise } })
 let waited = false
 const waiting = queue.waitForJob("cleanup").then(value => { waited = true; return value })
 await flush()
 assert.equal(queue.getJob("cleanup").status, "sent")
 assert.equal(waited, false)
 assert.equal(queue.stats().occupiedSlots, 1)
 assert.throws(() => enqueue("blocked"), error => error.code === "QUEUE_FULL")
 cleanup.resolve()
 assert.equal((await waiting).status, "sent")
 assert.equal(calls, 1)
 assert.equal(queue.stats().occupiedSlots, 0)
})

test("minimum interval and token-bucket refill both constrain attempts without busy waiting", async t => {
 const starts = []
 let clock
 const fixtureResult = fixture(t, async job => { starts.push([job.jobId, clock.now()]) }, { minIntervalMs: 200, burstCapacity: 2, refillPerSecond: 1 })
 clock = fixtureResult.clock
 for (const name of ["a", "b", "c"]) fixtureResult.enqueue(name)
 await flush()
 assert.deepEqual(starts, [["a", 0]])
 await clock.advance(199)
 assert.equal(starts.length, 1)
 await clock.advance(1)
 assert.deepEqual(starts[1], ["b", 200])
 await clock.advance(799)
 assert.equal(starts.length, 2)
 await clock.advance(1)
 assert.deepEqual(starts[2], ["c", 1000])
 assert.ok(clock.count() <= 1, "one shared scheduler timer bounds timer usage")
})

test("safe retries back off exponentially and block later jobs in the same session", async t => {
 const starts = []
 const { queue, clock, enqueue } = fixture(t, async (job, { markSending }) => {
  starts.push([job.jobId, job.attempts])
  if (job.jobId === "head" && job.attempts < 3) throw Object.assign(new Error("secret upstream URL"), { safeToRetry: true, code: "UPSTREAM_UNAVAILABLE" })
  markSending(`WA_${job.jobId}`)
  return { messageId: `WA_${job.jobId}` }
 })
 enqueue("head")
 enqueue("tail")
 await flush()
 assert.equal(queue.getJob("head").status, "retry_wait")
 assert.equal(queue.getJob("head").error.code, "UPSTREAM_UNAVAILABLE")
 await clock.advance(99)
 assert.equal(starts.length, 1)
 await clock.advance(1)
 assert.deepEqual(starts, [["head", 1], ["head", 2]])
 await clock.advance(200)
 assert.deepEqual(starts, [["head", 1], ["head", 2], ["head", 3], ["tail", 1]])
 assert.equal(queue.getJob("head").attempts, 3)
})

test("retry jitter is bounded and retry count is finite", async t => {
 const { queue, clock, enqueue } = fixture(t, async () => { throw Object.assign(new Error("temporary"), { safeToRetry: true }) }, { maxRetries: 1, retryJitter: 0.5 })
 enqueue("bounded")
 await flush()
 const retryAt = Date.parse(queue.getJob("bounded").nextAttemptAt)
 assert.ok(retryAt >= 50 && retryAt <= 150)
 await clock.advance(retryAt)
 assert.equal(queue.getJob("bounded").status, "failed")
 assert.equal(queue.getJob("bounded").attempts, 2)
})

test("permanent failures never retry and public snapshots and statistics omit private data", async t => {
 const { queue, enqueue } = fixture(t, async () => { throw Object.assign(new Error("API_KEY=private phone12025550123"), { code: "VALIDATION_FAILED", safeToRetry: false }) })
 enqueue("invalid", { metadata: { type: "text", privateContent: "sensitive" } })
 await flush()
 const snapshot = queue.getJob("invalid")
 assert.equal(snapshot.status, "failed")
 assert.equal(snapshot.attempts, 1)
 assert.deepEqual(snapshot.error, { code: "VALIDATION_FAILED", retryable: false })
 const publicJson = JSON.stringify([snapshot, queue.stats()])
 for (const secret of ["12025550123", "API_KEY", "sensitive", "privateContent", "payload"]) assert.equal(publicJson.includes(secret), false)
})

test("post-send exceptions are unknown even when an error claims it is retryable", async t => {
 let sends = 0
 const { queue, clock, enqueue } = fixture(t, async (job, { markSending }) => {
  markSending("WA_AMBIGUOUS")
  sends++
  throw Object.assign(new Error("connection reset after write"), { safeToRetry: true })
 })
 enqueue("ambiguous")
 await flush()
 assert.equal(queue.getJob("ambiguous").status, "unknown")
 assert.equal(queue.getJob("ambiguous").messageId, "WA_AMBIGUOUS")
 await clock.advance(999)
 assert.equal(sends, 1)
 assert.equal(queue.stats().unknownOutcomeJobs, 1)
 queue.updateAck({ messageId: "WA_AMBIGUOUS", status: "delivered" })
 assert.equal(queue.getJob("ambiguous").status, "delivered")
 assert.equal(queue.getJob("ambiguous").error, undefined)
})

test("disconnect pauses queued work and reconnect resumes it", async t => {
 const started = []
 const { queue, clock, enqueue } = fixture(t, async job => { started.push(job.jobId) })
 queue.setConnection("default", { state: "reconnecting", connected: false })
 enqueue("waiting")
 await clock.advance(500)
 assert.deepEqual(started, [])
 assert.equal(queue.stats().oldestPendingAgeMs, 500)
 queue.setConnection("default", { state: "connected", connected: true })
 await flush()
 assert.deepEqual(started, ["waiting"])
 assert.equal(queue.stats().averageWaitingMs, 500)
})

test("disconnect aborts safe preparation and retries only after reconnection", async t => {
 const started = []
 const { queue, clock, enqueue } = fixture(t, async (job, { signal, markSending }) => {
  started.push(job.attempts)
  if (job.attempts === 1) await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted preparation")), { once: true }))
  markSending("WA_RECONNECTED")
  return { messageId: "WA_RECONNECTED" }
 })
 enqueue("prepare")
 await flush()
 queue.setConnection("default", { state: "reconnecting", connected: false })
 await flush()
 assert.equal(queue.getJob("prepare").status, "retry_wait")
 await clock.advance(200)
 assert.deepEqual(started, [1])
 queue.setConnection("default", { state: "connected", connected: true })
 await flush()
 assert.deepEqual(started, [1, 2])
 assert.equal(queue.getJob("prepare").status, "sent")
})

test("authentication failure fails queued jobs and rejects admission until a new connection", async t => {
 const { queue, enqueue } = fixture(t, async () => ({}))
 queue.setConnection("default", { state: "reconnecting", connected: false })
 enqueue("pending")
 queue.setConnection("default", { state: "logged_out", connected: false })
 await flush()
 assert.equal(queue.getJob("pending").status, "failed")
 assert.equal(queue.getJob("pending").error.code, "AUTHENTICATION_REQUIRED")
 assert.throws(() => enqueue("rejected"), error => error.status === 503 && error.code === "AUTHENTICATION_REQUIRED")
 queue.setConnection("default", { state: "connected", connected: true })
 enqueue("repaired")
 await flush()
 assert.equal(queue.getJob("repaired").status, "sent")
})

test("authentication errors from a processor fail the session and waiting jobs", async t => {
 const { queue, enqueue } = fixture(t, async () => { throw Object.assign(new Error("logout"), { permanentAuthentication: true, safeToRetry: true }) })
 enqueue("active")
 enqueue("tail")
 await flush()
 assert.equal(queue.getJob("active").error.code, "AUTHENTICATION_REQUIRED")
 assert.equal(queue.getJob("tail").error.code, "AUTHENTICATION_REQUIRED")
 assert.equal(queue.stats().failedJobs, 2)
})

test("authentication errors after send begins keep its outcome unknown and fail later jobs", async t => {
 const { queue, enqueue } = fixture(t, async (job, { markSending }) => {
  markSending("AUTH_UNCERTAIN")
  throw Object.assign(new Error("logout after write"), { permanentAuthentication: true })
 })
 enqueue("active")
 enqueue("tail")
 await flush()
 assert.equal(queue.getJob("active").status, "unknown")
 assert.equal(queue.getJob("tail").status, "failed")
 assert.equal(queue.getJob("tail").error.code, "AUTHENTICATION_REQUIRED")
 assert.throws(() => enqueue("rejected"), error => error.code === "AUTHENTICATION_REQUIRED")
})

test("a permanent validation error remains permanent when disconnection races preparation", async t => {
 const gate = deferred()
 const { queue, enqueue } = fixture(t, async () => {
  await gate.promise
  throw Object.assign(new Error("invalid media"), { status: 415, code: "INVALID_MEDIA", safeToRetry: true })
 })
 enqueue("badMedia")
 await flush()
 queue.setConnection("default", { state: "reconnecting", connected: false })
 gate.resolve()
 await flush()
 assert.equal(queue.getJob("badMedia").status, "failed")
 assert.equal(queue.getJob("badMedia").attempts, 1)
})

test("early, duplicate, delayed, and out-of-order acknowledgements advance monotonically", async t => {
 const gate = deferred()
 const { queue, enqueue } = fixture(t, async (job, { markSending }) => {
  markSending("PREDICTED")
  await gate.promise
  return { messageId: "ACTUAL" }
 })
 queue.updateAck({ messageId: "PREDICTED", status: "read" })
 enqueue("acked")
 await flush()
 assert.equal(queue.getJob("acked").status, "read")
 gate.resolve()
 await flush()
 assert.equal(queue.getJob("acked").messageId, "ACTUAL")
 assert.equal(queue.updateAck({ messageId: "PREDICTED", status: "delivered" }), false)
 assert.equal(queue.updateAck({ messageId: "ACTUAL", status: "sent" }), false)
 const snapshot = queue.getJob("acked")
 assert.ok(snapshot.sentAt)
 assert.ok(snapshot.deliveredAt)
 assert.ok(snapshot.readAt)
 assert.equal(snapshot.status, "read")
})

test("failed jobs resist stale acknowledgements and acknowledgement buffers have strict bounds", async t => {
 const { queue, clock, enqueue } = fixture(t, async () => { throw new Error("permanent") }, { earlyAckLimit: 2 })
 enqueue("failed")
 await flush()
 for (const messageId of ["one", "two", "three"]) queue.updateAck({ messageId, status: "read" })
 assert.equal(queue.stats().earlyAcknowledgements, 2)
 assert.equal(queue.updateAck({ messageId: "invalid!", status: "read" }), false)
 assert.equal(queue.updateAck({ messageId: "valid", status: "pending" }), false)
 await clock.advance(1000)
 assert.equal(queue.stats().earlyAcknowledgements, 0)
})

test("queued jobs and abandoned reservations expire and clean up", async t => {
 let cleaned = 0
 const { queue, clock, enqueue } = fixture(t, async () => ({}), { maxJobAgeMs: 1000, stagingTtlMs: 1000 })
 queue.setConnection("default", { state: "qr_required", connected: false })
 enqueue("expired", { cleanup: async () => { cleaned++ } })
 const reservation = queue.reserve({ jobId: "abandoned" })
 await clock.advance(1000)
 assert.equal(queue.getJob("expired").status, "failed")
 assert.equal(queue.getJob("expired").error.code, "JOB_EXPIRED")
 assert.equal(cleaned, 1)
 assert.equal(queue.stats().occupiedSlots, 0)
 assert.throws(() => reservation.commit({ recipient: "phone", payload: {} }), error => error.code === "ADMISSION_EXPIRED")
})

test("processing timeouts fence late preparers and do not overlap an unresolved send", async t => {
 const gate = deferred()
 const started = []
 const { queue, clock, enqueue } = fixture(t, async (job, { markSending }) => {
  started.push(job.jobId)
  markSending(`WA_${job.jobId}`)
  if (job.jobId === "hung") await gate.promise
  return { messageId: `WA_${job.jobId}` }
 }, { jobTimeoutMs: 100 })
 enqueue("hung")
 enqueue("after")
 await clock.advance(100)
 assert.equal(queue.getJob("hung").status, "unknown")
 assert.deepEqual(started, ["hung"])
 assert.equal(queue.stats().activeJobs, 1)
 await clock.advance(100)
 assert.deepEqual(started, ["hung"])
 gate.resolve()
 await flush()
 assert.deepEqual(started, ["hung", "after"])
 assert.equal(queue.getJob("hung").status, "sent", "a reliable late send result can resolve uncertainty")
})

test("pre-send timeout prevents a delayed preparer from marking a send", async t => {
 const gate = deferred()
 let markError
 let sends = 0
 const { queue, clock, enqueue } = fixture(t, async (job, { markSending }) => {
  await gate.promise
  try { markSending("LATE"); sends++ } catch (error) { markError = error; throw error }
 }, { jobTimeoutMs: 100 })
 enqueue("late")
 await clock.advance(100)
 assert.equal(queue.getJob("late").status, "failed")
 assert.equal(queue.getJob("late").error.code, "PROCESSING_TIMEOUT")
 gate.resolve()
 await flush()
 assert.equal(sends, 0)
 assert.equal(markError.code, "CONNECTION_UNAVAILABLE")
})

test("status history and message ID mappings expire and completed history count is bounded", async t => {
 const { queue, clock, enqueue } = fixture(t, async job => ({ messageId: `WA_${job.jobId}` }), { statusRetention: 2 })
 for (const name of ["a", "b", "c"]) { enqueue(name); await flush() }
 assert.equal(queue.getJob("a"), null)
 assert.equal(queue.stats().retainedStatuses, 2)
 assert.equal(queue.getJob("c").status, "sent")
 await clock.advance(1000)
 assert.equal(queue.getJob("b"), null)
 assert.equal(queue.getJob("c"), null)
 assert.equal(queue.stats().retainedStatuses, 0)
 assert.equal(clock.count(), 0)
})

test("per-session metrics stay isolated and a reliable acknowledgement resolves an unknown send", async t => {
 const { queue, enqueue } = fixture(t, async (job, { markSending }) => {
  markSending(`WA_${job.jobId}`)
  if (job.sessionId === "other") throw new Error("uncertain")
  return { messageId: `WA_${job.jobId}` }
 })
 queue.setConnection("other", { state: "connected", connected: true })
 enqueue("ok")
 enqueue("uncertain", { sessionId: "other" })
 await flush()
 assert.equal(queue.stats("default").successfulSends, 1)
 assert.equal(queue.stats("default").unknownOutcomeJobs, 0)
 assert.equal(queue.stats("other").successfulSends, 0)
 assert.equal(queue.stats("other").unknownOutcomeJobs, 1)
 queue.updateAck({ sessionId: "other", messageId: "WA_uncertain", status: "read" })
 queue.updateAck({ sessionId: "other", messageId: "WA_uncertain", status: "read" })
 assert.equal(queue.stats("other").successfulSends, 1)
 assert.equal(queue.stats().successfulSends, 2)
 assert.equal(queue.stats("absent").successfulSends, 0)
})

test("invalid IDs, oversized payloads, and excessive sessions cannot grow memory without bounds", async t => {
 const { queue, enqueue } = fixture(t, async () => ({}), { maxSessions: 1, payloadMaxBytes: 1024 })
 for (const jobId of ["../other", "", "x".repeat(129), 1, null]) assert.throws(() => enqueue(jobId), error => error.status === 400)
 assert.throws(() => enqueue("oversized", { payload: { text: "x".repeat(1024) } }), error => error.status === 413)
 assert.throws(() => queue.setConnection("other", { connected: true }), error => error.code === "SESSION_LIMIT")
 assert.equal(queue.stats().occupiedSlots, 0)
 assert.equal(queue.stats().retainedStatuses, 0)
 const reservation = queue.reserve({ jobId: "invalidRecipient" })
 assert.throws(() => reservation.commit({ recipient: "\n", payload: {} }), error => error.code === "INVALID_RECIPIENT")
 reservation.release()
})

test("waiters time out with current state and have bounded memory", async t => {
 const { queue, clock, enqueue } = fixture(t, async () => ({}), { maxPending: 1 })
 queue.setConnection("default", { state: "reconnecting", connected: false })
 enqueue("waiting")
 const first = queue.waitForJob("waiting", 100)
 const second = queue.waitForJob("waiting", 100)
 await assert.rejects(queue.waitForJob("waiting", 100), error => error.code === "WAITER_LIMIT")
 await clock.advance(100)
 assert.equal((await first).status, "queued")
 assert.equal((await second).status, "queued")
 assert.equal(await queue.waitForJob("missing", 100), null)
})

test("graceful shutdown drains active work, cancels queued work, and clears timers", async t => {
 const gate = deferred()
 let cleaned = 0
 const { queue, clock, enqueue } = fixture(t, async (job, { markSending }) => { markSending("ACTIVE"); await gate.promise; return { messageId: "ACTIVE" } })
 enqueue("active", { cleanup: async () => { cleaned++ } })
 enqueue("queued", { cleanup: async () => { cleaned++ } })
 await flush()
 const waiting = queue.waitForJob("queued", 500)
 const shutdown = queue.shutdown({ drainMs: 200 })
 assert.throws(() => enqueue("rejected"), error => error.code === "WORKER_SHUTTING_DOWN")
 await flush()
 assert.equal((await waiting).status, "cancelled")
 gate.resolve()
 await flush()
 await shutdown
 assert.equal(queue.getJob("active").status, "sent")
 assert.equal(queue.getJob("queued").status, "cancelled")
 assert.equal(cleaned, 2)
 assert.equal(clock.count(), 0)
})

test("bounded shutdown marks unresolved sends unknown and fences their late continuations", async t => {
 const gate = deferred()
 let cleaned = 0
 const { queue, clock, enqueue } = fixture(t, async (job, { markSending }) => { markSending("UNRESOLVED"); await gate.promise })
 enqueue("active", { cleanup: async () => { cleaned++ } })
 await flush()
 const shutdown = queue.shutdown({ drainMs: 100 })
 await clock.advance(100)
 await shutdown
 assert.equal(queue.getJob("active").status, "unknown")
 assert.equal(cleaned, 1)
 assert.equal(clock.count(), 0)
 gate.resolve()
 await flush()
 assert.equal(queue.getJob("active").status, "unknown")
})

test("shutdown waits within its remaining budget for cleanup that started before shutdown", async t => {
 const cleanup = deferred()
 let completed = false
 const { queue, clock, enqueue } = fixture(t, async () => ({}))
 enqueue("cleaning", { cleanup: () => cleanup.promise })
 await flush()
 assert.equal(queue.stats().activeJobs, 0)
 assert.equal(queue.stats().occupiedSlots, 1)
 const shutdown = queue.shutdown({ drainMs: 200 }).then(() => { completed = true })
 await flush()
 assert.equal(completed, false)
 await clock.advance(100)
 assert.equal(completed, false)
 cleanup.resolve()
 await shutdown
 assert.equal(queue.stats().occupiedSlots, 0)
 assert.equal(clock.count(), 0)
})

test("shutdown waits for cleanup of a send that completes during its active drain", async t => {
 const sending = deferred()
 const cleanup = deferred()
 let completed = false
 const { queue, clock, enqueue } = fixture(t, async (job, { markSending }) => {
  markSending("DRAINING")
  await sending.promise
  return { messageId: "DRAINING" }
 })
 enqueue("draining", { cleanup: () => cleanup.promise })
 await flush()
 const shutdown = queue.shutdown({ drainMs: 200 }).then(() => { completed = true })
 await clock.advance(50)
 sending.resolve()
 await flush()
 assert.equal(completed, false)
 assert.equal(queue.getJob("draining").status, "sent")
 assert.equal(queue.stats().occupiedSlots, 1)
 cleanup.resolve()
 await shutdown
 assert.equal(queue.stats().occupiedSlots, 0)
 assert.equal(clock.count(), 0)
})

test("uncooperative cleanup cannot extend shutdown beyond its remaining drain budget", async t => {
 const cleanup = deferred()
 const { queue, clock, enqueue } = fixture(t, async () => ({}))
 enqueue("stuckCleanup", { cleanup: () => cleanup.promise })
 await flush()
 const shutdown = queue.shutdown({ drainMs: 100 })
 await clock.advance(100)
 await shutdown
 assert.equal(clock.count(), 0)
 cleanup.resolve()
 await flush()
 assert.equal(queue.stats().occupiedSlots, 0)
})

test("failed cleanup is counted and does not leak admission slots or timers", async t => {
 const { queue, enqueue } = fixture(t, async () => ({}))
 enqueue("cleanupFailure", { cleanup: async () => { throw new Error("private path") } })
 await flush()
 assert.equal(queue.stats().cleanupFailures, 1)
 assert.equal(queue.stats().occupiedSlots, 0)
 assert.equal(queue.getJob("cleanupFailure").status, "sent")
})
