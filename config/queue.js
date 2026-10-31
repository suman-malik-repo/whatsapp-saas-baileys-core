const definitions = {
 concurrency: ["QUEUE_CONCURRENCY", 1, 1, 16],
 maxPending: ["QUEUE_MAX_PENDING", 100, 1, 10000],
 maxSessions: ["QUEUE_MAX_SESSIONS", 16, 1, 1000],
 statusRetention: ["QUEUE_STATUS_RETENTION", 1000, 1, 100000],
 statusTtlMs: ["QUEUE_STATUS_TTL_MS", 3600000, 1000, 604800000],
 minIntervalMs: ["QUEUE_MIN_INTERVAL_MS", 1000, 0, 3600000],
 burstCapacity: ["QUEUE_BURST_CAPACITY", 1, 1, 100],
 refillPerSecond: ["QUEUE_REFILL_PER_SECOND", 1, 0.001, 100, true],
 maxRetries: ["QUEUE_MAX_RETRIES", 2, 0, 20],
 retryBaseMs: ["QUEUE_RETRY_BASE_MS", 1000, 1, 3600000],
 retryMaxMs: ["QUEUE_RETRY_MAX_MS", 30000, 1, 3600000],
 retryJitter: ["QUEUE_RETRY_JITTER", 0.2, 0, 1, true],
 maxJobAgeMs: ["QUEUE_MAX_JOB_AGE_MS", 300000, 1000, 86400000],
 drainMs: ["QUEUE_DRAIN_MS", 10000, 0, 300000],
 jobTimeoutMs: ["QUEUE_JOB_TIMEOUT_MS", 90000, 1, 3600000],
 earlyAckLimit: ["QUEUE_EARLY_ACK_LIMIT", 1000, 1, 100000],
 earlyAckTtlMs: ["QUEUE_EARLY_ACK_TTL_MS", 60000, 1000, 3600000],
 stagingMaxBytes: ["QUEUE_STAGING_MAX_BYTES", 256 * 1024 * 1024, 1, 10 * 1024 * 1024 * 1024],
 stagingMaxFiles: ["QUEUE_STAGING_MAX_FILES", 32, 1, 1000],
 stagingTtlMs: ["QUEUE_STAGING_TTL_MS", 300000, 1000, 86400000],
 maxUploads: ["QUEUE_MAX_UPLOADS", 1, 1, 32],
 httpWaitMs: ["QUEUE_HTTP_WAIT_MS", 25000, 0, 60000],
 payloadMaxBytes: ["QUEUE_PAYLOAD_MAX_BYTES", 32768, 1024, 1048576]
}

function loadQueueConfig(env = process.env, overrides = {}) {
 if (!env || typeof env !== "object" || !overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
  throw new TypeError("Queue configuration must be an object")
 }
 const known = new Set([...Object.keys(definitions), "apiMode"])
 for (const name of Object.keys(overrides)) {
  if (!known.has(name)) throw new TypeError(`Unknown queue configuration: ${name}`)
 }
 const config = {}
 for (const [name, [variable, fallback, minimum, maximum, decimal]] of Object.entries(definitions)) {
  const raw = Object.hasOwn(overrides, name) ? overrides[name] : (Object.hasOwn(env, variable) ? env[variable] : fallback)
  const validString = typeof raw === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)
  const value = typeof raw === "number" || validString ? Number(raw) : NaN
  if (!Number.isFinite(value) || (!decimal && !Number.isSafeInteger(value)) || value < minimum || value > maximum) {
   throw new TypeError(`${variable} must be ${decimal ? "a number" : "an integer"} between ${minimum} and ${maximum}`)
  }
  config[name] = value
 }
 config.apiMode = Object.hasOwn(overrides, "apiMode") ? overrides.apiMode : (env.QUEUE_API_MODE ?? "queued")
 if (!["queued", "wait"].includes(config.apiMode)) throw new TypeError("QUEUE_API_MODE must be queued or wait")
 if (config.retryMaxMs < config.retryBaseMs) throw new TypeError("QUEUE_RETRY_MAX_MS must be at least QUEUE_RETRY_BASE_MS")
 if (config.stagingTtlMs < config.maxJobAgeMs) throw new TypeError("QUEUE_STAGING_TTL_MS must be at least QUEUE_MAX_JOB_AGE_MS")
 return Object.freeze(config)
}

module.exports = { loadQueueConfig }
