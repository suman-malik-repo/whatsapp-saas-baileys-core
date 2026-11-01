const fs = require("node:fs/promises")
const path = require("node:path")
const { createHash, randomUUID } = require("node:crypto")
const processOwnerToken = randomUUID()

async function processIdentity(pid) {
 if (process.platform !== "linux") return null
 try {
  const [boot, stat] = await Promise.all([fs.readFile("/proc/sys/kernel/random/boot_id", "utf8"), fs.readFile(`/proc/${pid}/stat`, "utf8")])
  const startTicks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]
  return `${boot.trim()}:${startTicks}`
 } catch { return null }
}

// One bounded, checksummed snapshot is the durable journal. A rename only occurs
// after fsync, and callers receive success only after the directory is synced.
async function createManagedJournal({ dataDir, maxBytes = 16 * 1024 * 1024, maxJobs = 10000, maxEvents = 20000 }) {
 const directory = path.resolve(dataDir)
 await fs.mkdir(directory, { recursive: true, mode: 0o700 })
 const filename = path.join(directory, "managed-journal.json")
 const lockPath = path.join(directory, "managed-worker.lock")
 let lock
 try { lock = await fs.open(lockPath, "wx", 0o600) }
 catch (error) {
  if (error.code !== "EEXIST") throw error
  const value = JSON.parse(await fs.readFile(lockPath, "utf8"))
  if (!Number.isSafeInteger(value.pid) || value.pid < 1) throw new Error("Invalid managed worker lock")
  // Render/container restarts can reuse the old PID. A PID alone does not prove
  // the process which created the lock still exists.
  const currentIdentity = await processIdentity(value.pid)
  const reused = value.pid === process.pid && value.ownerToken && value.ownerToken !== processOwnerToken || value.startIdentity && currentIdentity && value.startIdentity !== currentIdentity
  if (!reused) {
   try { process.kill(value.pid, 0); throw new Error("Managed data directory is already in use") }
   catch (failure) { if (failure.code !== "ESRCH") throw failure }
  }
  await fs.unlink(lockPath)
  lock = await fs.open(lockPath, "wx", 0o600)
 }
 await lock.writeFile(JSON.stringify({ pid: process.pid, ownerToken: processOwnerToken, startIdentity: await processIdentity(process.pid) }))
 await lock.sync()
 let current = { version: 1, assignment: null, state: "unassigned", jobs: {}, outbox: [], operations: {} }
 try {
  const stats = await fs.stat(filename)
  if (stats.size > maxBytes) throw new Error("Managed journal exceeds limit")
  const envelope = JSON.parse(await fs.readFile(filename, "utf8"))
  const data = JSON.stringify(envelope.data)
  if (envelope.checksum !== createHash("sha256").update(data).digest("hex") || envelope.data?.version !== 1 ||
      !envelope.data.jobs || !Array.isArray(envelope.data.outbox) || !envelope.data.operations) throw new Error("Managed journal integrity check failed")
  current = envelope.data
 } catch (error) {
  if (error.code !== "ENOENT") { await lock.close(); await fs.unlink(lockPath); throw error }
 }
 let queue = Promise.resolve()
 let failure = null
 let closed = false
 async function syncDirectory() {
  let handle
  try { handle = await fs.open(directory, "r"); await handle.sync() }
  catch (error) { if (process.platform !== "win32" || !["EPERM", "EISDIR", "EINVAL"].includes(error.code)) throw error }
  finally { await handle?.close() }
 }
 function update(mutate) {
  const operation = queue.then(async () => {
   if (closed || failure) throw new Error("Managed journal is unavailable")
   const next = structuredClone(current)
   const result = mutate(next)
   if (result && typeof result.then === "function") throw new Error("Journal mutations must be synchronous")
   if (Object.keys(next.jobs).length > maxJobs || next.outbox.length > maxEvents || Object.keys(next.operations).length > 10000) throw new Error("Managed journal capacity exhausted")
   const serialized = JSON.stringify(next)
   const envelope = JSON.stringify({ checksum: createHash("sha256").update(serialized).digest("hex"), data: next })
   if (Buffer.byteLength(envelope) > maxBytes) throw new Error("Managed journal capacity exhausted")
   const temporary = path.join(directory, `.managed-${randomUUID()}.tmp`)
   let handle
   try {
    handle = await fs.open(temporary, "wx", 0o600)
    await handle.writeFile(envelope)
    await handle.sync()
    await handle.close(); handle = null
    await fs.rename(temporary, filename)
    await syncDirectory()
    current = next
    return result
   } catch (error) {
    failure = error
    await handle?.close().catch(() => {})
    await fs.unlink(temporary).catch(() => {})
    throw error
   }
  })
  queue = operation.catch(() => {})
  return operation
 }
 return {
  read: () => structuredClone(current), update,
  async close() { await queue; closed = true; await lock.close(); await fs.unlink(lockPath) }
 }
}
module.exports = { createManagedJournal }
