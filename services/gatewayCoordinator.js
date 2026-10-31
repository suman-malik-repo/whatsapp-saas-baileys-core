// A transport boundary for a future durable gateway, intentionally disconnected
// from the local queue. The gateway MUST atomically verify token, fence and lease
// for every write. These client checks alone cannot prevent distributed races.
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const METHODS = ["claimJobs", "acknowledgeClaim", "updateProcessingStatus", "reportSendResult",
 "renewLease", "releaseRetryable", "recoverExpiredClaims"]
const STATUSES = new Set(["queued", "processing", "sent", "delivered", "read", "retry_wait", "failed", "cancelled", "unknown"])
const RESULTS = new Set(["sent", "delivered", "read", "failed", "cancelled", "unknown"])
const FENCED = new Set(["CLAIM_FENCED", "CLAIM_NOT_OWNED", "LEASE_EXPIRED", "STALE_FENCE"])

function coordinatorError(code, status = 503) {
 return Object.assign(new Error("Gateway coordination could not complete"), { code, status, expose: true })
}

function createGatewayCoordinator({ transport, workerId, now = Date.now, maxClaims = 100 } = {}) {
 if (typeof workerId !== "string" || !ID.test(workerId)) throw new TypeError("workerId must be a bounded identifier")
 if (!transport || METHODS.some((name) => typeof transport[name] !== "function")) throw new TypeError("The gateway transport must implement all coordinator methods")
 if (typeof now !== "function" || !Number.isSafeInteger(maxClaims) || maxClaims < 1 || maxClaims > 100) throw new TypeError("Invalid coordinator clock or claim limit")
 const claims = new Map()
 let pendingClaims = 0

 function ownership(record) {
  return Object.freeze(Object.fromEntries(["jobId", "sessionId", "workerId", "token", "fence", "leaseExpiresAt"].map((key) => [key, record[key]])))
 }
 function snapshot(record) { return Object.freeze({ ...ownership(record), sendStarted: record.sendStarted }) }
 function validClaim(value) {
  if (!value || typeof value.jobId !== "string" || !ID.test(value.jobId) ||
      typeof value.sessionId !== "string" || !ID.test(value.sessionId) || value.workerId !== workerId ||
      typeof value.token !== "string" || !/^[!-~]{1,256}$/.test(value.token) ||
      !Number.isSafeInteger(value.fence) || value.fence < 1 ||
      !Number.isSafeInteger(value.leaseExpiresAt) || value.leaseExpiresAt <= now() ||
      (value.sendStarted !== undefined && typeof value.sendStarted !== "boolean")) {
   throw coordinatorError("INVALID_GATEWAY_CLAIM", 502)
  }
  return { ...ownership(value), sendStarted: value.sendStarted === true }
 }
 function current(claim) {
  const record = claim && claims.get(claim.jobId)
  if (!record || claim.sessionId !== record.sessionId || claim.workerId !== workerId ||
      claim.token !== record.token || claim.fence !== record.fence) throw coordinatorError("CLAIM_NOT_OWNED", 409)
  if (record.leaseExpiresAt <= now()) {
   claims.delete(record.jobId)
   throw coordinatorError("LEASE_EXPIRED", 410)
  }
  return record
 }
 function checkSignal(signal) { if (signal?.aborted) throw coordinatorError("GATEWAY_ABORTED", 499) }
 function limitValue(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxClaims) throw coordinatorError("INVALID_CLAIM_LIMIT", 400)
  return limit
 }
 async function call(method, payload) {
  checkSignal(payload.signal)
  try { return await transport[method](payload) }
  catch (error) {
   if (FENCED.has(error?.code)) throw coordinatorError(error.code, error.code === "LEASE_EXPIRED" ? 410 : 409)
   checkSignal(payload.signal)
   throw coordinatorError("GATEWAY_UNAVAILABLE")
  }
 }
 async function write(method, claim, fields, signal) {
  const record = current(claim)
  try {
   const result = await call(method, { ownership: ownership(record), ...fields, signal })
   checkSignal(signal)
   if (claims.get(record.jobId) !== record) throw coordinatorError("CLAIM_NOT_OWNED", 409)
   current(claim)
   return { result, record }
  } catch (error) {
   if (FENCED.has(error.code) && claims.get(record.jobId) === record) claims.delete(record.jobId)
   throw error
  }
 }

 async function claimJobs({ limit = 1, signal } = {}) {
  limitValue(limit)
  for (const [id, record] of claims) if (record.leaseExpiresAt <= now()) claims.delete(id)
  if (claims.size + pendingClaims + limit > maxClaims) throw coordinatorError("GATEWAY_CLAIM_CAPACITY")
  pendingClaims += limit
  try {
   const result = await call("claimJobs", { workerId, limit, signal })
   checkSignal(signal)
   if (!Array.isArray(result) || result.length > limit) throw coordinatorError("INVALID_GATEWAY_CLAIM", 502)
   const validated = result.map(validClaim)
   const ids = new Set()
   for (const record of validated) {
    const previous = claims.get(record.jobId)
    if (ids.has(record.jobId) || (previous && record.fence <= previous.fence)) throw coordinatorError("INVALID_GATEWAY_CLAIM", 502)
    ids.add(record.jobId)
   }
   for (const record of validated) claims.set(record.jobId, record)
   return validated.map(snapshot)
  } finally { pendingClaims -= limit }
 }

 async function acknowledgeClaim(claim, { signal } = {}) {
  return (await write("acknowledgeClaim", claim, {}, signal)).result
 }
 async function updateProcessingStatus(claim, status, { signal, sendStarted = status === "processing" } = {}) {
  if (!STATUSES.has(status) || typeof sendStarted !== "boolean") throw coordinatorError("INVALID_PROCESSING_STATUS", 400)
  const record = current(claim)
  // Sticky even if the transport fails: the remote write may have succeeded.
  record.sendStarted ||= sendStarted
  return (await write("updateProcessingStatus", claim, { status, sendStarted: record.sendStarted }, signal)).result
 }
 async function reportSendResult(claim, result, { signal } = {}) {
  if (!result || !RESULTS.has(result.status) ||
      (result.messageId !== undefined && (typeof result.messageId !== "string" || !ID.test(result.messageId))) ||
      (result.errorCode !== undefined && (typeof result.errorCode !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(result.errorCode)))) {
   throw coordinatorError("INVALID_SEND_RESULT", 400)
  }
  const safe = { status: result.status }
  if (result.messageId !== undefined) safe.messageId = result.messageId
  if (result.errorCode !== undefined) safe.errorCode = result.errorCode
  const written = await write("reportSendResult", claim, { result: safe }, signal)
  claims.delete(written.record.jobId)
  return written.result
 }
 async function renewLease(claim, { signal, leaseMs } = {}) {
  if (leaseMs !== undefined && (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 3_600_000)) throw coordinatorError("INVALID_LEASE_DURATION", 400)
  const requestedLease = current(claim).leaseExpiresAt
  const { result, record } = await write("renewLease", claim, leaseMs === undefined ? {} : { leaseMs }, signal)
  if (!Number.isSafeInteger(result?.leaseExpiresAt) || result.leaseExpiresAt <= now() || result.leaseExpiresAt < requestedLease) throw coordinatorError("INVALID_GATEWAY_LEASE", 502)
  // Concurrent responses can arrive in reverse order for the same owner.
  record.leaseExpiresAt = Math.max(record.leaseExpiresAt, result.leaseExpiresAt)
  return snapshot(record)
 }
 async function releaseRetryable(claim, { signal, errorCode = "TEMPORARY_CONNECTIVITY", retryAt } = {}) {
  if (current(claim).sendStarted) throw coordinatorError("AMBIGUOUS_SEND_REQUIRES_RECONCILIATION", 409)
  if (typeof errorCode !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(errorCode) ||
      (retryAt !== undefined && (!Number.isSafeInteger(retryAt) || retryAt < now()))) throw coordinatorError("INVALID_RETRY_RELEASE", 400)
  const fields = { errorCode, sendStarted: false }
  if (retryAt !== undefined) fields.retryAt = retryAt
  const written = await write("releaseRetryable", claim, fields, signal)
  // A concurrent start invalidates release even if a remote implementation was
  // faulty. The gateway must enforce this guard atomically too.
  if (written.record.sendStarted) throw coordinatorError("AMBIGUOUS_SEND_REQUIRES_RECONCILIATION", 409)
  claims.delete(written.record.jobId)
  return written.result
 }
 async function recoverExpiredClaims({ limit = maxClaims, signal } = {}) {
  limitValue(limit)
  const result = await call("recoverExpiredClaims", { workerId, limit, signal,
   expiredStartedPolicy: "unknown", expiredUnstartedPolicy: "retry", requireReconciliation: true })
  checkSignal(signal)
  if (!result || ["recovered", "unknown", "retryable"].some((name) =>
   !Number.isSafeInteger(result[name]) || result[name] < 0 || result[name] > limit) ||
   result.unknown + result.retryable > result.recovered) throw coordinatorError("INVALID_RECOVERY_RESULT", 502)
  return Object.freeze({ recovered: result.recovered, unknown: result.unknown, retryable: result.retryable })
 }

 return { claimJobs, acknowledgeClaim, updateProcessingStatus, reportSendResult, renewLease,
  releaseRetryable, recoverExpiredClaims, stats: () => ({ activeClaims: claims.size, pendingClaims, maxClaims }) }
}

module.exports = { createGatewayCoordinator }
