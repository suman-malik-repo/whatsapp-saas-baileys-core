const assert = require("node:assert/strict")
const test = require("node:test")
const { createGatewayCoordinator } = require("../services/gatewayCoordinator")

const names = ["claimJobs", "acknowledgeClaim", "updateProcessingStatus", "reportSendResult", "renewLease", "releaseRetryable", "recoverExpiredClaims"]
const claim = (overrides = {}) => ({ jobId: "job_1", sessionId: "session_1", workerId: "worker_1",
 token: "opaque-token-1", fence: 1, leaseExpiresAt: 2000, ...overrides })
const deferred = () => {
 let resolve, reject
 const promise = new Promise((yes, no) => { resolve = yes; reject = no })
 return { promise, resolve, reject }
}

function fixture(overrides = {}, options = {}) {
 let clock = 1000
 const calls = []
 const defaults = {
  claimJobs: () => [claim()],
  renewLease: () => ({ leaseExpiresAt: 3000 }),
  recoverExpiredClaims: () => ({ recovered: 0, unknown: 0, retryable: 0 })
 }
 const transport = Object.fromEntries(names.map((name) => [name, async (payload) => {
  calls.push({ name, payload })
  return (overrides[name] || defaults[name] || (() => ({ accepted: true })))(payload)
 }]))
 const coordinator = createGatewayCoordinator({ transport, workerId: "worker_1", now: () => clock, ...options })
 return { coordinator, calls, transport, setTime: (value) => { clock = value } }
}

test("coordinator requires an explicit complete transport and bounded worker identity", () => {
 for (const options of [{}, { transport: {} }, { workerId: "bad worker" }]) {
  assert.throws(() => createGatewayCoordinator(options), TypeError)
 }
 for (const maxClaims of [0, 101, NaN, 1.5]) assert.throws(() => fixture({}, { maxClaims }), TypeError)
})

test("all claimed writes carry current complete ownership without request payload secrets", async () => {
 const { coordinator, calls } = fixture()
 const [owned] = await coordinator.claimJobs()
 assert.equal(Object.isFrozen(owned), true)
 await coordinator.acknowledgeClaim(owned)
 await coordinator.updateProcessingStatus(owned, "queued", { sendStarted: false })
 const renewed = await coordinator.renewLease(owned, { leaseMs: 5000 })
 assert.equal(renewed.leaseExpiresAt, 3000)
 await coordinator.reportSendResult(owned, { status: "sent", messageId: "WA_1", phone: "discarded", token: "discarded" })
 for (const call of calls.filter((call) => call.name !== "claimJobs")) {
  assert.deepEqual(Object.keys(call.payload.ownership).sort(), ["jobId", "sessionId", "workerId", "token", "fence", "leaseExpiresAt"].sort())
  assert.equal(call.payload.ownership.token, owned.token)
 }
 assert.equal(calls.at(-1).payload.ownership.leaseExpiresAt, 3000)
 assert.deepEqual(calls.at(-1).payload.result, { status: "sent", messageId: "WA_1" })
 assert.equal(coordinator.stats().activeClaims, 0)
})

test("invalid transport claims are rejected before any are retained", async () => {
 for (const invalid of [claim({ jobId: 1 }), claim({ jobId: "x".repeat(129) }), claim({ sessionId: "bad id" }),
  claim({ workerId: "another_worker" }), claim({ token: "bad\nsecret" }), claim({ token: "x".repeat(257) }),
  claim({ fence: 0 }), claim({ leaseExpiresAt: "2000" }), claim({ leaseExpiresAt: 1000 }), claim({ sendStarted: "false" })]) {
  const { coordinator } = fixture({ claimJobs: () => [invalid] })
  await assert.rejects(coordinator.claimJobs(), { code: "INVALID_GATEWAY_CLAIM" })
  assert.equal(coordinator.stats().activeClaims, 0)
  assert.equal(coordinator.stats().pendingClaims, 0)
 }
 for (const response of [{ claims: [] }, [claim(), claim()]]) {
  const { coordinator } = fixture({ claimJobs: () => response })
  await assert.rejects(coordinator.claimJobs(), { code: "INVALID_GATEWAY_CLAIM" })
 }
})

test("duplicate or regressing claim fences cannot replace a current owner", async () => {
 let returned = [claim()]
 const { coordinator } = fixture({ claimJobs: () => returned })
 const [owned] = await coordinator.claimJobs()
 returned = [claim({ token: "other-token", fence: 1 })]
 await assert.rejects(coordinator.claimJobs(), { code: "INVALID_GATEWAY_CLAIM" })
 returned = [claim({ jobId: "job_2" }), claim({ jobId: "job_2", fence: 2 })]
 await assert.rejects(coordinator.claimJobs({ limit: 2 }), { code: "INVALID_GATEWAY_CLAIM" })
 await coordinator.acknowledgeClaim(owned)
 assert.equal(coordinator.stats().activeClaims, 1)
})

test("claim admission accounts for concurrent requests before awaiting transport", async () => {
 const gate = deferred()
 const { coordinator, calls } = fixture({ claimJobs: () => gate.promise }, { maxClaims: 2 })
 const pending = coordinator.claimJobs({ limit: 2 })
 assert.equal(coordinator.stats().pendingClaims, 2)
 await assert.rejects(coordinator.claimJobs(), { code: "GATEWAY_CLAIM_CAPACITY" })
 assert.equal(calls.length, 1)
 gate.resolve([claim(), claim({ jobId: "job_2" })])
 await pending
 assert.equal(coordinator.stats().activeClaims, 2)
 assert.equal(coordinator.stats().pendingClaims, 0)
})

test("claim limits and cancellation reject without creating unbounded ownership", async () => {
 const { coordinator, calls } = fixture()
 for (const limit of [0, -1, 101, 1.5]) await assert.rejects(coordinator.claimJobs({ limit }), { code: "INVALID_CLAIM_LIMIT" })
 const controller = new AbortController()
 controller.abort()
 await assert.rejects(coordinator.claimJobs({ signal: controller.signal }), { code: "GATEWAY_ABORTED" })
 assert.equal(calls.length, 0)
 assert.equal(coordinator.stats().pendingClaims, 0)
})

test("expired claims reject all writes and can be replaced by newly claimed work", async () => {
 let next = claim()
 const { coordinator, calls, setTime } = fixture({ claimJobs: () => [next] }, { maxClaims: 1 })
 const [owned] = await coordinator.claimJobs()
 setTime(2000)
 await assert.rejects(coordinator.acknowledgeClaim(owned), { code: "LEASE_EXPIRED" })
 assert.equal(calls.length, 1)
 next = claim({ fence: 2, token: "new-token", leaseExpiresAt: 4000 })
 const [replacement] = await coordinator.claimJobs()
 await coordinator.acknowledgeClaim(replacement)
})

test("replaced tokens and fences reject stale writes without touching the current owner", async () => {
 let next = claim()
 const { coordinator, calls } = fixture({ claimJobs: () => [next] })
 const [old] = await coordinator.claimJobs()
 next = claim({ fence: 2, token: "new-token" })
 const [current] = await coordinator.claimJobs()
 await assert.rejects(coordinator.reportSendResult(old, { status: "sent" }), { code: "CLAIM_NOT_OWNED" })
 assert.equal(calls.length, 2)
 await coordinator.acknowledgeClaim(current)
 assert.equal(coordinator.stats().activeClaims, 1)
})

test("a late renewal cannot overwrite replacement ownership", async () => {
 const gate = deferred()
 let next = claim()
 const { coordinator } = fixture({ claimJobs: () => [next], renewLease: () => gate.promise })
 const [old] = await coordinator.claimJobs()
 const renewal = coordinator.renewLease(old)
 next = claim({ fence: 2, token: "new-token", leaseExpiresAt: 4000 })
 const [current] = await coordinator.claimJobs()
 gate.resolve({ leaseExpiresAt: 9000 })
 await assert.rejects(renewal, { code: "CLAIM_NOT_OWNED" })
 await coordinator.acknowledgeClaim(current)
})

test("a renewal arriving after the local lease expires is rejected", async () => {
 const gate = deferred()
 const { coordinator, setTime } = fixture({ renewLease: () => gate.promise })
 const [owned] = await coordinator.claimJobs()
 const renewal = coordinator.renewLease(owned)
 setTime(2001)
 gate.resolve({ leaseExpiresAt: 9000 })
 await assert.rejects(renewal, { code: "LEASE_EXPIRED" })
 assert.equal(coordinator.stats().activeClaims, 0)
})

test("out of order renewal responses never shorten the current lease", async () => {
 const first = deferred(), second = deferred()
 let count = 0
 const { coordinator } = fixture({ renewLease: () => (++count === 1 ? first.promise : second.promise) })
 const [owned] = await coordinator.claimJobs()
 const earlier = coordinator.renewLease(owned)
 const later = coordinator.renewLease(owned)
 second.resolve({ leaseExpiresAt: 8000 })
 assert.equal((await later).leaseExpiresAt, 8000)
 first.resolve({ leaseExpiresAt: 5000 })
 assert.equal((await earlier).leaseExpiresAt, 8000)
})

test("malformed or shortened gateway renewals cannot change local ownership", async () => {
 for (const leaseExpiresAt of ["3000", 999, 1500]) {
  const { coordinator, calls } = fixture({ renewLease: () => ({ leaseExpiresAt }) })
  const [owned] = await coordinator.claimJobs()
  await assert.rejects(coordinator.renewLease(owned), { code: "INVALID_GATEWAY_LEASE" })
  await coordinator.acknowledgeClaim(owned)
  assert.equal(calls.at(-1).payload.ownership.leaseExpiresAt, 2000)
 }
})

test("server fence rejections revoke only the failed local ownership", async () => {
 const { coordinator } = fixture({ acknowledgeClaim: () => { throw Object.assign(new Error("secret"), { code: "CLAIM_FENCED" }) } })
 const [owned] = await coordinator.claimJobs()
 await assert.rejects(coordinator.acknowledgeClaim(owned), (error) => error.code === "CLAIM_FENCED" && !error.message.includes("secret"))
 await assert.rejects(coordinator.renewLease(owned), { code: "CLAIM_NOT_OWNED" })
 assert.equal(coordinator.stats().activeClaims, 0)
})

test("safe releases include an explicit never-started condition and retire local ownership", async () => {
 const { coordinator, calls } = fixture()
 const [owned] = await coordinator.claimJobs()
 await coordinator.updateProcessingStatus(owned, "processing", { sendStarted: false })
 await coordinator.releaseRetryable(owned, { retryAt: 1500, errorCode: "DISCONNECTED" })
 assert.equal(calls.at(-1).payload.sendStarted, false)
 assert.equal(calls.at(-1).payload.retryAt, 1500)
 assert.equal(coordinator.stats().activeClaims, 0)
 await assert.rejects(coordinator.acknowledgeClaim(owned), { code: "CLAIM_NOT_OWNED" })
})

test("started or ambiguously persisted sends cannot be released for automatic retry", async () => {
 const { coordinator, calls } = fixture({ updateProcessingStatus: () => { throw new Error("gateway disconnected after write") } })
 const [owned] = await coordinator.claimJobs()
 await assert.rejects(coordinator.updateProcessingStatus(owned, "processing"), { code: "GATEWAY_UNAVAILABLE" })
 await assert.rejects(coordinator.releaseRetryable(owned), { code: "AMBIGUOUS_SEND_REQUIRES_RECONCILIATION" })
 assert.equal(calls.some((call) => call.name === "releaseRetryable"), false)
})

test("invalid status, result, renewal and release fields do not reach the transport", async () => {
 const { coordinator, calls } = fixture()
 const [owned] = await coordinator.claimJobs()
 await assert.rejects(coordinator.updateProcessingStatus(owned, "nonsense"), { code: "INVALID_PROCESSING_STATUS" })
 await assert.rejects(coordinator.reportSendResult(owned, { status: "sent", messageId: "bad id" }), { code: "INVALID_SEND_RESULT" })
 await assert.rejects(coordinator.reportSendResult(owned, { status: "failed", errorCode: "private message" }), { code: "INVALID_SEND_RESULT" })
 await assert.rejects(coordinator.renewLease(owned, { leaseMs: 0 }), { code: "INVALID_LEASE_DURATION" })
 await assert.rejects(coordinator.releaseRetryable(owned, { retryAt: 0 }), { code: "INVALID_RETRY_RELEASE" })
 assert.equal(calls.length, 1)
})

test("expired claim recovery explicitly reconciles started sends instead of blind retries", async () => {
 const { coordinator, calls } = fixture({ recoverExpiredClaims: () => ({ recovered: 3, unknown: 2, retryable: 1 }) })
 assert.deepEqual(await coordinator.recoverExpiredClaims({ limit: 5 }), { recovered: 3, unknown: 2, retryable: 1 })
 assert.equal(calls[0].payload.expiredStartedPolicy, "unknown")
 assert.equal(calls[0].payload.expiredUnstartedPolicy, "retry")
 assert.equal(calls[0].payload.requireReconciliation, true)
 assert.equal(calls[0].payload.workerId, "worker_1")
})

test("recovery summaries and unknown transport errors are sanitized", async () => {
 const bad = fixture({ recoverExpiredClaims: () => ({ recovered: 1, unknown: 3, retryable: 0 }) })
 await assert.rejects(bad.coordinator.recoverExpiredClaims(), { code: "INVALID_RECOVERY_RESULT" })
 const unavailable = fixture({ claimJobs: () => { throw new Error("https://secret.example/key") } })
 await assert.rejects(unavailable.coordinator.claimJobs(), (error) => error.code === "GATEWAY_UNAVAILABLE" && !error.message.includes("secret"))
 assert.equal(unavailable.coordinator.stats().pendingClaims, 0)
})
