const test = require("node:test")
const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

const source = fs.readFileSync(path.join(__dirname, "..", "config", "socket.js"), "utf8")
const reasons = {
 connectionClosed: 428,
 connectionLost: 408,
 connectionReplaced: 440,
 loggedOut: 401,
 badSession: 500,
 restartRequired: 515,
 multideviceMismatch: 411,
 forbidden: 403
}

function deferred() {
 let resolve
 let reject
 const promise = new Promise((resolvePromise, rejectPromise) => {
  resolve = resolvePromise
  reject = rejectPromise
 })
 return { promise, resolve, reject }
}

const settle = () => new Promise(setImmediate)

function loadSocket(options = {}) {
 const sockets = []
 const authPaths = []
 const timers = new Map()
 const qrCodes = []
 const archivedPaths = []
 const createdDirectories = []
 let timerId = 0
 let now = Date.parse("2026-01-01T00:00:00.000Z")
 let authCalls = 0
 let saveCalls = 0
 const fakeMath = Object.create(Math)
 fakeMath.random = () => options.random ?? 0.5

 const fakeBaileys = {
  DisconnectReason: reasons,
  useMultiFileAuthState: async (authPath) => {
   authPaths.push(authPath)
   authCalls += 1
   if (options.authFactory) return options.authFactory(authCalls)
   return {
    state: { creds: {} },
    saveCreds: async () => {
     saveCalls += 1
     if (options.saveCreds) return options.saveCreds(saveCalls)
    }
   }
  },
  default: (config) => {
   if (options.makeSocket) return options.makeSocket(config)
   const currentSocket = {
    ev: new EventEmitter(),
    config,
    closeCalls: 0,
    end() {
     this.closeCalls += 1
     this.ev.emit("connection.update", { connection: "close" })
     if (options.endThrows) throw new Error("transport already closed")
    }
   }
   sockets.push(currentSocket)
   return currentSocket
  }
 }

 const sandbox = {
  __dirname: path.join(__dirname, "..", "config"),
  module: { exports: {} },
  require(name) {
   if (name === "node:path") return path
   if (name === "node:fs/promises") return {
    async mkdir(directory, config) {
     createdDirectories.push({ directory, config })
     if (options.mkdir) return options.mkdir(directory)
    },
    async rename(from, to) {
     archivedPaths.push({ from, to })
     if (options.rename) return options.rename(from, to)
    }
   }
   if (name === "node:crypto") return { randomUUID: () => "test-unique-id" }
   if (name === "@whiskeysockets/baileys") return fakeBaileys
   if (name === "qrcode-terminal") return { generate: (qr) => qrCodes.push(qr) }
   if (name === "pino") return () => ({})
   throw new Error(`Unexpected dependency: ${name}`)
  },
  console: { log() {}, error() {} },
  Date: class extends Date {
   static now() { return now }
  },
  Math: fakeMath,
  setTimeout(callback, delay) {
   const id = ++timerId
   timers.set(id, { callback, delay })
   return id
  },
  clearTimeout(id) { timers.delete(id) }
 }
 vm.runInNewContext(source, sandbox, { filename: "config/socket.js" })

 return {
  ...sandbox.module.exports,
  sockets,
  authPaths,
  timers,
  qrCodes,
  archivedPaths,
  createdDirectories,
  get authCalls() { return authCalls },
  get saveCalls() { return saveCalls },
  advanceTime(ms) { now += ms },
  async runTimer(delay) {
   if (delay === undefined) assert.equal(timers.size, 1)
   const [id, timer] = delay === undefined
    ? timers.entries().next().value
    : [...timers.entries()].find(([, entry]) => entry.delay === delay)
   timers.delete(id)
   now += timer.delay
   timer.callback()
   await settle()
  }
 }
}

function close(socket, code) {
 socket.ev.emit("connection.update", {
  connection: "close",
  lastDisconnect: { error: { output: { statusCode: code } } }
 })
}

test("socket is available only after open and authentication path is anchored to the server", async () => {
 const manager = loadSocket()
 assert.equal(manager.getSocket(), null)
 assert.equal(manager.getConnectionStatus().state, "stopped")
 await manager.startWhatsApp()
 const socket = manager.sockets[0]
 assert.equal(manager.getSocket(), null)
 assert.equal(manager.getConnectionStatus().state, "connecting")
 assert.equal(manager.authPaths[0], path.join(__dirname, "..", "auth"))
 assert.equal("version" in socket.config, false)

 socket.ev.emit("connection.update", { qr: "test-qr" })
 assert.equal(manager.getConnectionStatus().state, "qr_required")
 assert.deepEqual(manager.qrCodes, ["test-qr"])
 socket.ev.emit("connection.update", { connection: "open" })
 assert.equal(manager.getSocket(), socket)
 assert.equal(manager.getConnectionStatus().connected, true)
 assert.doesNotThrow(() => JSON.stringify(manager.getConnectionStatus()))
})

test("concurrent starts share one pending initialization", async () => {
 const auth = deferred()
 const manager = loadSocket({ authFactory: () => auth.promise })
 const first = manager.startWhatsApp()
 const second = manager.startWhatsApp()
 assert.equal(first, second)
 await settle()
 assert.equal(manager.authCalls, 1)
 auth.resolve({ state: {}, saveCreds: async () => {} })
 await first
 assert.equal(manager.sockets.length, 1)
 await manager.startWhatsApp()
 assert.equal(manager.sockets.length, 1)
})

test("disconnect removes readiness and retries with capped exponential backoff", async () => {
 const manager = loadSocket()
 await manager.startWhatsApp()
 let socket = manager.sockets[0]
 socket.ev.emit("connection.update", { connection: "open" })
 for (const expectedDelay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
  close(socket, reasons.connectionLost)
  assert.equal(manager.getSocket(), null)
  assert.equal(manager.getConnectionStatus().state, "reconnecting")
  assert.equal(manager.getConnectionStatus().lastDisconnectCode, reasons.connectionLost)
  assert.equal(manager.timers.values().next().value.delay, expectedDelay)
  assert.equal(typeof manager.getConnectionStatus().nextRetryAt, "string")
  await manager.startWhatsApp()
  assert.equal(manager.timers.size, 1)
  await manager.runTimer()
  socket = manager.sockets.at(-1)
 }
 socket.ev.emit("connection.update", { connection: "open" })
 assert.equal(manager.getConnectionStatus().reconnectAttempts, 0)
 assert.equal(manager.getConnectionStatus().nextRetryAt, null)
})

test("retry delay includes jitter", async () => {
 const manager = loadSocket({ random: 0 })
 await manager.startWhatsApp()
 close(manager.sockets[0], reasons.connectionClosed)
 assert.equal(manager.timers.values().next().value.delay, 800)
})

test("pairing restart reconnects promptly", async () => {
 const manager = loadSocket()
 await manager.startWhatsApp()
 close(manager.sockets[0], reasons.restartRequired)
 assert.equal(manager.timers.values().next().value.delay, 250)
 await manager.runTimer()
 assert.equal(manager.sockets.length, 2)
})

for (const reason of ["loggedOut", "badSession", "connectionReplaced", "forbidden", "multideviceMismatch"]) {
 test(`${reason} stops automatic reconnects`, async () => {
  const manager = loadSocket()
  await manager.startWhatsApp()
  const socket = manager.sockets[0]
  socket.ev.emit("connection.update", { connection: "open" })
  close(socket, reasons[reason])
  assert.equal(manager.getSocket(), null)
  assert.equal(manager.getConnectionStatus().connected, false)
  assert.equal(manager.getConnectionStatus().state, reason === "loggedOut" ? "logged_out" : "failed")
  assert.equal(manager.timers.size, 0)
  assert.equal(manager.getConnectionStatus().nextRetryAt, null)
 })
}

test("authentication initialization errors are handled and retried", async () => {
 const manager = loadSocket({
  authFactory: (calls) => {
   if (calls === 1) throw new Error("test storage failure")
   return { state: {}, saveCreds: async () => {} }
  }
 })
 assert.equal(await manager.startWhatsApp(), null)
 assert.equal(manager.getConnectionStatus().state, "reconnecting")
 await manager.runTimer()
 assert.equal(manager.sockets.length, 1)
})

test("socket constructor errors are handled and retried", async () => {
 const manager = loadSocket({ makeSocket() { throw new Error("test constructor failure") } })
 assert.equal(await manager.startWhatsApp(), null)
 assert.equal(manager.getConnectionStatus().state, "reconnecting")
 assert.equal(manager.timers.size, 1)
})

test("credential persistence failures remove readiness and require storage repair", async () => {
 const manager = loadSocket({ saveCreds() { throw new Error("test write failure") } })
 await manager.startWhatsApp()
 const socket = manager.sockets[0]
 socket.ev.emit("connection.update", { connection: "open" })
 socket.ev.emit("creds.update", {})
 await settle()
 assert.equal(manager.saveCalls, 1)
 assert.equal(manager.getSocket(), null)
 assert.equal(manager.getConnectionStatus().state, "failed")
 assert.equal(socket.closeCalls, 1)
 assert.equal(manager.timers.size, 0)
})

test("credential writes run sequentially", async () => {
 const firstWrite = deferred()
 const manager = loadSocket({ saveCreds: (calls) => calls === 1 ? firstWrite.promise : undefined })
 await manager.startWhatsApp()
 const socket = manager.sockets[0]
 socket.ev.emit("creds.update", {})
 socket.ev.emit("creds.update", {})
 await settle()
 assert.equal(manager.saveCalls, 1)
 firstWrite.resolve()
 await settle()
 assert.equal(manager.saveCalls, 2)
})

test("late old-socket events cannot affect the replacement connection", async () => {
 const manager = loadSocket()
 await manager.startWhatsApp()
 const staleSocket = manager.sockets[0]
 close(staleSocket, reasons.restartRequired)
 await manager.runTimer()
 const currentSocket = manager.sockets[1]
 currentSocket.ev.emit("connection.update", { connection: "open" })
 staleSocket.ev.emit("connection.update", { connection: "open", qr: "stale-qr" })
 close(staleSocket, reasons.loggedOut)
 staleSocket.ev.emit("creds.update", {})
 await settle()
 assert.equal(manager.getSocket(), currentSocket)
 assert.equal(manager.getConnectionStatus().state, "connected")
 assert.equal(manager.timers.size, 0)
 assert.equal(manager.saveCalls, 0)
 assert.equal(manager.qrCodes.length, 0)
})

test("credential updates accepted immediately before restart are saved", async () => {
 const manager = loadSocket()
 await manager.startWhatsApp()
 manager.sockets[0].ev.emit("creds.update", {})
 close(manager.sockets[0], reasons.restartRequired)
 await settle()
 assert.equal(manager.saveCalls, 1)
 await manager.runTimer()
 assert.equal(manager.authCalls, 2)
 assert.equal(manager.sockets.length, 2)
})

test("replacement authentication waits for accepted credential writes to finish", async () => {
 const write = deferred()
 const manager = loadSocket({ saveCreds: () => write.promise })
 await manager.startWhatsApp()
 manager.sockets[0].ev.emit("creds.update", {})
 await settle()
 close(manager.sockets[0], reasons.restartRequired)
 await manager.runTimer()
 assert.equal(manager.authCalls, 1)
 assert.equal(manager.sockets.length, 1)
 assert.equal(manager.getSocket(), null)
 write.resolve()
 await settle()
 assert.equal(manager.authCalls, 2)
 assert.equal(manager.sockets.length, 2)
 const currentSocket = manager.sockets[1]
 currentSocket.ev.emit("connection.update", { connection: "open" })
 assert.equal(manager.getSocket(), currentSocket)
 assert.equal(manager.getConnectionStatus().state, "connected")
})

test("credential-write failure while closing cancels the pending retry", async () => {
 const manager = loadSocket({ saveCreds() { throw new Error("write failed during close") } })
 await manager.startWhatsApp()
 manager.sockets[0].ev.emit("creds.update", {})
 close(manager.sockets[0], reasons.restartRequired)
 await settle()
 assert.equal(manager.saveCalls, 1)
 assert.equal(manager.timers.size, 0)
 assert.equal(manager.getConnectionStatus().state, "failed")
 assert.equal(await manager.startWhatsApp(), null)
 assert.equal(manager.authCalls, 1)
})

test("failed credential drain prevents an already-started replacement from loading auth", async () => {
 const write = deferred()
 const manager = loadSocket({ saveCreds: () => write.promise })
 await manager.startWhatsApp()
 manager.sockets[0].ev.emit("creds.update", {})
 await settle()
 close(manager.sockets[0], reasons.restartRequired)
 await manager.runTimer()
 assert.equal(manager.authCalls, 1)
 write.reject(new Error("write failed while next connection waited"))
 await settle()
 assert.equal(manager.getConnectionStatus().state, "failed")
 assert.equal(manager.getSocket(), null)
 assert.equal(manager.authCalls, 1)
 assert.equal(manager.sockets.length, 1)
 assert.equal(manager.timers.size, 0)
 assert.equal(await manager.startWhatsApp(), null)
})

test("shutdown cancels pending retries", async () => {
 const manager = loadSocket()
 await manager.startWhatsApp()
 close(manager.sockets[0], reasons.connectionLost)
 assert.equal(manager.timers.size, 1)
 manager.stopWhatsApp()
 assert.equal(manager.timers.size, 0)
 assert.equal(manager.getConnectionStatus().state, "stopped")
 assert.equal(manager.getConnectionStatus().nextRetryAt, null)
 assert.equal(manager.getSocket(), null)
})

test("shutdown closes the transport safely without logging out", async () => {
 const manager = loadSocket({ endThrows: true })
 await manager.startWhatsApp()
 const socket = manager.sockets[0]
 socket.ev.emit("connection.update", { connection: "open" })
 assert.doesNotThrow(() => manager.stopWhatsApp())
 assert.equal(socket.closeCalls, 1)
 socket.ev.emit("connection.update", { connection: "open" })
 assert.equal(manager.getSocket(), null)
 assert.equal(manager.getConnectionStatus().state, "stopped")
 assert.equal(manager.timers.size, 0)
})

test("shutdown during pending initialization cannot create a socket or schedule retries", async () => {
 const auth = deferred()
 const manager = loadSocket({ authFactory: () => auth.promise })
 const start = manager.startWhatsApp()
 await settle()
 manager.stopWhatsApp()
 auth.resolve({ state: {}, saveCreds: async () => {} })
 assert.equal(await start, null)
 assert.equal(manager.sockets.length, 0)
 assert.equal(manager.timers.size, 0)
 assert.equal(manager.getConnectionStatus().state, "stopped")
})

test("start after shutdown waits for a cancelled initialization and starts a fresh connection", async () => {
 const firstAuth = deferred()
 const manager = loadSocket({
  authFactory: (calls) => calls === 1
   ? firstAuth.promise
   : { state: {}, saveCreds: async () => {} }
 })
 const firstStart = manager.startWhatsApp()
 await settle()
 manager.stopWhatsApp()
 const secondStart = manager.startWhatsApp()
 assert.notEqual(secondStart, firstStart)
 assert.equal(manager.startWhatsApp(), secondStart)
 assert.equal(manager.authCalls, 1)
 firstAuth.resolve({ state: {}, saveCreds: async () => {} })
 assert.equal(await firstStart, null)
 await secondStart
 assert.equal(manager.authCalls, 2)
 assert.equal(manager.sockets.length, 1)
 assert.equal(manager.getConnectionStatus().state, "connecting")
 manager.sockets[0].ev.emit("connection.update", { connection: "open" })
 assert.equal(manager.getSocket(), manager.sockets[0])
})

test("shutdown drains credential writes accepted before transport closure", async () => {
 const write = deferred()
 const manager = loadSocket({ saveCreds: () => write.promise })
 await manager.startWhatsApp()
 manager.sockets[0].ev.emit("creds.update", {})
 const stopped = manager.stopWhatsApp()
 let drained = false
 stopped.then(() => { drained = true })
 await settle()
 assert.equal(manager.saveCalls, 1)
 assert.equal(drained, false)
 assert.equal(manager.getConnectionStatus().state, "stopped")
 write.resolve()
 await stopped
 assert.equal(drained, true)
 assert.equal(manager.getConnectionStatus().state, "stopped")
 assert.equal(manager.timers.size, 0)
})

test("shutdown ignores a late credential-write failure", async () => {
 const write = deferred()
 const manager = loadSocket({ saveCreds: () => write.promise })
 await manager.startWhatsApp()
 manager.sockets[0].ev.emit("creds.update", {})
 await settle()
 manager.stopWhatsApp()
 write.reject(new Error("write failed after shutdown"))
 await settle()
 assert.equal(manager.getConnectionStatus().state, "stopped")
 assert.equal(manager.timers.size, 0)
})

test("QR snapshots contain actual Baileys text and expire after the configured lifetime", async () => {
 const manager = loadSocket()
 assert.equal(manager.getQrStatus().qr, null)
 await manager.startWhatsApp()
 assert.equal(manager.sockets[0].config.qrTimeout, 20000)
 manager.sockets[0].ev.emit("connection.update", { qr: "actual-baileys-pairing-text" })
 const status = manager.getQrStatus()
 assert.equal(status.qr, "actual-baileys-pairing-text")
 assert.equal(status.generatedAt, "2026-01-01T00:00:00.000Z")
 assert.equal(status.expiresAt, "2026-01-01T00:00:20.000Z")
 manager.advanceTime(19999)
 assert.equal(manager.getQrStatus().qr, status.qr)
 manager.advanceTime(1)
 assert.equal(manager.getQrStatus().qr, null)
 assert.equal(manager.getQrStatus().generatedAt, null)
 assert.equal(manager.getQrStatus().expiresAt, null)
 assert.equal(manager.timers.size, 0)
})

test("reading a current QR without refresh reuses it", async () => {
 const manager = loadSocket()
 await manager.startWhatsApp()
 manager.sockets[0].ev.emit("connection.update", { qr: "current-qr" })
 const result = await manager.requestQr({ fresh: false })
 assert.equal(result.qr, "current-qr")
 assert.equal(manager.sockets.length, 1)
 assert.equal(manager.sockets[0].closeCalls, 0)
 assert.equal(manager.timers.size, 0)
})

test("concurrent fresh QR requests share one new unpaired connection and ignore stale events", async () => {
 const manager = loadSocket()
 await manager.startWhatsApp()
 const oldSocket = manager.sockets[0]
 oldSocket.ev.emit("connection.update", { qr: "old-qr" })
 const first = manager.requestQr()
 const second = manager.requestQr()
 assert.equal(first, second)
 assert.equal(manager.getQrStatus().qr, null)
 oldSocket.ev.emit("connection.update", { qr: "old-qr-rotated-too-late" })
 await settle()
 assert.equal(manager.sockets.length, 2)
 assert.equal(oldSocket.closeCalls, 1)
 oldSocket.ev.emit("connection.update", { qr: "stale-qr" })
 oldSocket.ev.emit("creds.update", {})
 assert.equal(manager.getQrStatus().qr, null)
 manager.sockets[1].ev.emit("connection.update", { qr: "new-valid-qr" })
 assert.equal((await first).qr, "new-valid-qr")
 assert.equal((await second).qr, "new-valid-qr")
 assert.equal(manager.saveCalls, 0)
 assert.equal(manager.timers.size, 0)
})

test("requests awaiting the initial QR do not restart the initial connection", async () => {
 const manager = loadSocket()
 await manager.startWhatsApp()
 const first = manager.requestQr()
 await settle()
 const second = manager.requestQr()
 assert.equal(first, second)
 assert.equal(manager.sockets.length, 1)
 assert.equal(manager.sockets[0].closeCalls, 0)
 manager.sockets[0].ev.emit("connection.update", { qr: "initial-qr" })
 assert.equal((await first).qr, "initial-qr")
 assert.equal(manager.timers.size, 0)
})

test("QR waiting is bounded and a later request still uses the pending connection", async () => {
 const manager = loadSocket()
 await manager.startWhatsApp()
 const first = manager.requestQr({ timeoutMs: 15000 })
 await manager.runTimer(15000)
 const pending = await first
 assert.equal(pending.state, "connecting")
 assert.equal(pending.qr, null)
 assert.equal(manager.timers.size, 0)
 const second = manager.requestQr()
 await settle()
 assert.equal(manager.sockets.length, 1)
 manager.sockets[0].ev.emit("connection.update", { qr: "eventually-generated-qr" })
 assert.equal((await second).qr, "eventually-generated-qr")
 assert.equal(manager.timers.size, 0)
})

test("connected sessions clear QR data and cannot be refreshed or logged out", async () => {
 const manager = loadSocket()
 await manager.startWhatsApp()
 const socket = manager.sockets[0]
 socket.ev.emit("connection.update", { qr: "before-open" })
 socket.ev.emit("connection.update", { connection: "open" })
 const result = await manager.requestQr()
 assert.equal(result.connected, true)
 assert.equal(result.qr, null)
 assert.equal(result.generatedAt, null)
 assert.equal(socket.closeCalls, 0)
 assert.equal(manager.sockets.length, 1)
 assert.equal(manager.timers.size, 0)
})

test("scanned QR pairing clears the code and is allowed to finish its restart", async () => {
 const manager = loadSocket()
 await manager.startWhatsApp()
 const socket = manager.sockets[0]
 socket.ev.emit("connection.update", { qr: "scanned-qr" })
 socket.ev.emit("connection.update", { isNewLogin: true, qr: undefined })
 assert.equal(manager.getQrStatus().qr, null)
 const request = manager.requestQr()
 await settle()
 assert.equal(socket.closeCalls, 0)
 socket.ev.emit("connection.update", { qr: "late-qr-after-scan" })
 assert.equal(manager.getQrStatus().qr, null)
 close(socket, reasons.restartRequired)
 await manager.runTimer(250)
 manager.sockets[1].ev.emit("connection.update", { connection: "open" })
 assert.equal((await request).connected, true)
 assert.equal(manager.sockets.length, 2)
 assert.equal(manager.timers.size, 0)
})

test("fresh requests resume registered sessions without replacing their credentials", async () => {
 const manager = loadSocket({
  authFactory: () => ({ state: { creds: { registered: true } }, saveCreds: async () => {} })
 })
 await manager.startWhatsApp()
 const request = manager.requestQr({ timeoutMs: 500 })
 await settle()
 assert.equal(manager.sockets.length, 1)
 assert.equal(manager.sockets[0].closeCalls, 0)
 assert.equal(manager.archivedPaths.length, 0)
 manager.sockets[0].ev.emit("connection.update", { connection: "open" })
 assert.equal((await request).connected, true)
 close(manager.sockets[0], reasons.connectionLost)
 const offline = manager.requestQr({ timeoutMs: 500 })
 await manager.runTimer(500)
 assert.equal((await offline).state, "reconnecting")
 assert.equal(manager.archivedPaths.length, 0)
 assert.equal(manager.sockets.length, 1)
})

test("QR refresh drains accepted writes and stops if the code is scanned meanwhile", async () => {
 const write = deferred()
 const manager = loadSocket({ saveCreds: () => write.promise })
 await manager.startWhatsApp()
 const socket = manager.sockets[0]
 socket.ev.emit("connection.update", { qr: "to-be-scanned" })
 socket.ev.emit("creds.update", {})
 await settle()
 const request = manager.requestQr()
 socket.ev.emit("connection.update", { qr: "ignored-while-refreshing" })
 assert.equal(manager.getQrStatus().qr, null)
 socket.ev.emit("connection.update", { isNewLogin: true })
 write.resolve()
 await settle()
 assert.equal(socket.closeCalls, 0)
 assert.equal(manager.sockets.length, 1)
 socket.ev.emit("connection.update", { connection: "open" })
 assert.equal((await request).connected, true)
 assert.equal(manager.timers.size, 0)
})

test("QR refresh persists every accepted credential write before loading replacement auth", async () => {
 const write = deferred()
 const manager = loadSocket({ saveCreds: (calls) => calls === 1 ? write.promise : undefined })
 await manager.startWhatsApp()
 const socket = manager.sockets[0]
 socket.ev.emit("connection.update", { qr: "old-code" })
 socket.ev.emit("creds.update", {})
 await settle()
 const request = manager.requestQr()
 socket.ev.emit("creds.update", {})
 assert.equal(manager.authCalls, 1)
 write.resolve()
 await settle()
 assert.equal(manager.saveCalls, 2)
 assert.equal(manager.authCalls, 2)
 manager.sockets[1].ev.emit("connection.update", { qr: "replacement-code" })
 assert.equal((await request).qr, "replacement-code")
})

for (const reason of ["loggedOut", "badSession"]) {
 test(`explicit fresh QR requests archive ${reason} auth and start a new pairing`, async () => {
  const manager = loadSocket({
   authFactory: (calls) => ({ state: { creds: calls === 1 ? { registered: true } : {} }, saveCreds: async () => {} })
  })
  await manager.startWhatsApp()
  close(manager.sockets[0], reasons[reason])
  const readOnly = await manager.requestQr({ fresh: false })
  assert.equal(readOnly.qr, null)
  assert.equal(manager.archivedPaths.length, 0)
  const request = manager.requestQr()
  await settle()
  assert.equal(manager.archivedPaths.length, 1)
  assert.equal(manager.archivedPaths[0].from, path.join(__dirname, "..", "auth"))
  assert.equal(path.dirname(manager.archivedPaths[0].to), path.join(__dirname, "..", "auth-backups"))
  assert.match(path.basename(manager.archivedPaths[0].to), /^\d+-test-unique-id$/)
  assert.equal(manager.sockets.length, 2)
  manager.sockets[1].ev.emit("connection.update", { qr: "new-session-qr" })
  assert.equal((await request).qr, "new-session-qr")
  assert.equal(manager.timers.size, 0)
 })
}

for (const reason of ["connectionReplaced", "forbidden", "multideviceMismatch"]) {
 test(`QR requests do not archive auth or bypass ${reason}`, async () => {
  const manager = loadSocket()
  await manager.startWhatsApp()
  close(manager.sockets[0], reasons[reason])
  const result = await manager.requestQr()
  assert.equal(result.state, "failed")
  assert.equal(result.qr, null)
  assert.equal(manager.archivedPaths.length, 0)
  assert.equal(manager.authCalls, 1)
  assert.equal(manager.timers.size, 0)
 })
}

test("failed auth archival leaves the old session in place and reports failure", async () => {
 const manager = loadSocket({ rename() { throw Object.assign(new Error("access denied"), { code: "EACCES" }) } })
 await manager.startWhatsApp()
 close(manager.sockets[0], reasons.loggedOut)
 const request = manager.requestQr()
 await settle()
 assert.equal((await request).state, "failed")
 assert.equal(manager.authCalls, 1)
 assert.equal(manager.sockets.length, 1)
 assert.equal(manager.timers.size, 0)
})

test("shutdown during QR refresh clears waiters and prevents replacement sockets", async () => {
 const write = deferred()
 const manager = loadSocket({ saveCreds: () => write.promise })
 await manager.startWhatsApp()
 manager.sockets[0].ev.emit("connection.update", { qr: "old-code" })
 manager.sockets[0].ev.emit("creds.update", {})
 await settle()
 const request = manager.requestQr()
 const stopped = manager.stopWhatsApp()
 assert.equal((await request).state, "stopped")
 assert.equal(manager.getQrStatus().qr, null)
 assert.equal(manager.timers.size, 0)
 write.resolve()
 await stopped
 await settle()
 assert.equal(manager.sockets.length, 1)
 assert.equal(manager.authCalls, 1)
 assert.equal(manager.getConnectionStatus().state, "stopped")
 assert.equal((await manager.requestQr()).state, "stopped")
})

test("shutdown during auth archival cannot rename the session or create a socket", async () => {
 const directory = deferred()
 const manager = loadSocket({ mkdir: () => directory.promise })
 await manager.startWhatsApp()
 close(manager.sockets[0], reasons.loggedOut)
 const request = manager.requestQr()
 await settle()
 assert.equal(manager.createdDirectories.length, 1)
 manager.stopWhatsApp()
 assert.equal((await request).state, "stopped")
 directory.resolve()
 await settle()
 assert.equal(manager.archivedPaths.length, 0)
 assert.equal(manager.authCalls, 1)
 assert.equal(manager.sockets.length, 1)
 assert.equal(manager.timers.size, 0)
})

test("auth archival waits for all credentials accepted before the terminal close", async () => {
 const write = deferred()
 const manager = loadSocket({ saveCreds: () => write.promise })
 await manager.startWhatsApp()
 manager.sockets[0].ev.emit("creds.update", {})
 close(manager.sockets[0], reasons.loggedOut)
 const request = manager.requestQr()
 await settle()
 assert.equal(manager.createdDirectories.length, 0)
 assert.equal(manager.archivedPaths.length, 0)
 assert.equal(manager.authCalls, 1)
 write.resolve()
 await settle()
 assert.equal(manager.archivedPaths.length, 1)
 assert.equal(manager.authCalls, 2)
 manager.sockets[1].ev.emit("connection.update", { qr: "fresh-after-drain" })
 assert.equal((await request).qr, "fresh-after-drain")
})

test("credential failure during QR refresh clears the QR and resolves waiting requests", async () => {
 const write = deferred()
 const manager = loadSocket({ saveCreds: () => write.promise })
 await manager.startWhatsApp()
 manager.sockets[0].ev.emit("connection.update", { qr: "old-qr" })
 manager.sockets[0].ev.emit("creds.update", {})
 await settle()
 const request = manager.requestQr()
 write.reject(new Error("cannot persist pairing credentials"))
 await settle()
 const result = await request
 assert.equal(result.state, "failed")
 assert.equal(result.qr, null)
 assert.equal(result.generatedAt, null)
 assert.equal(manager.timers.size, 0)
 assert.equal(manager.authCalls, 1)
 assert.equal(manager.archivedPaths.length, 0)
})

for (const reason of ["loggedOut", "forbidden"]) {
 test(`a ${reason} close while QR refresh drains writes cannot be bypassed`, async () => {
  const write = deferred()
  const manager = loadSocket({ saveCreds: () => write.promise })
  await manager.startWhatsApp()
  const socket = manager.sockets[0]
  socket.ev.emit("connection.update", { qr: "old-qr" })
  socket.ev.emit("creds.update", {})
  await settle()
  const request = manager.requestQr()
  close(socket, reasons[reason])
  const terminalState = reason === "loggedOut" ? "logged_out" : "failed"
  assert.equal((await request).state, terminalState)
  write.resolve()
  await settle()
  assert.equal(manager.getConnectionStatus().state, terminalState)
  assert.equal(manager.getConnectionStatus().lastDisconnectCode, reasons[reason])
  assert.equal(manager.sockets.length, 1)
  assert.equal(manager.authCalls, 1)
  assert.equal(manager.archivedPaths.length, 0)
  assert.equal(manager.timers.size, 0)

  // Logging out permits new pairing only when a later request explicitly asks
  // for it; a forbidden session remains blocked without any new auth loading.
  const later = manager.requestQr()
  await settle()
  if (reason === "loggedOut") {
   assert.equal(manager.archivedPaths.length, 1)
   assert.equal(manager.authCalls, 2)
   manager.sockets[1].ev.emit("connection.update", { qr: "explicit-recovery-qr" })
   assert.equal((await later).qr, "explicit-recovery-qr")
  } else {
   assert.equal((await later).state, "failed")
   assert.equal(manager.authCalls, 1)
   assert.equal(manager.archivedPaths.length, 0)
  }
 })
}

test("a retryable close during QR refresh keeps its scheduled reconnect policy", async () => {
 const write = deferred()
 const manager = loadSocket({ saveCreds: () => write.promise })
 await manager.startWhatsApp()
 const socket = manager.sockets[0]
 socket.ev.emit("connection.update", { qr: "old-qr" })
 socket.ev.emit("creds.update", {})
 await settle()
 const request = manager.requestQr()
 close(socket, reasons.connectionLost)
 write.resolve()
 await settle()
 assert.equal(manager.getConnectionStatus().state, "reconnecting")
 assert.equal(manager.sockets.length, 1)
 assert.equal(manager.authCalls, 1)
 assert.equal(manager.archivedPaths.length, 0)
 assert.equal([...manager.timers.values()].some(({ delay }) => delay === 1000), true)
 await manager.runTimer(1000)
 assert.equal(manager.sockets.length, 2)
 manager.sockets[1].ev.emit("connection.update", { qr: "automatically-reconnected-qr" })
 assert.equal((await request).qr, "automatically-reconnected-qr")
 assert.equal(manager.timers.size, 0)
})

test("an explicit restart during an in-flight auth rename waits and starts with new auth", async () => {
 const rename = deferred()
 const manager = loadSocket({
  rename: () => rename.promise,
  authFactory: (calls) => ({ state: { creds: calls === 1 ? { registered: true } : {} }, saveCreds: async () => {} })
 })
 await manager.startWhatsApp()
 close(manager.sockets[0], reasons.loggedOut)
 const pairing = manager.requestQr()
 await settle()
 assert.equal(manager.archivedPaths.length, 1)
 manager.stopWhatsApp()
 assert.equal((await pairing).state, "stopped")
 const restart = manager.startWhatsApp()
 assert.equal(manager.startWhatsApp(), restart)
 await settle()
 assert.equal(manager.authCalls, 1)
 assert.equal(manager.sockets.length, 1)
 rename.resolve()
 const restartedSocket = await restart
 await settle()
 assert.equal(restartedSocket, manager.sockets[1])
 assert.equal(manager.authCalls, 2)
 assert.equal(manager.sockets.length, 2)
 assert.equal(manager.getConnectionStatus().state, "connecting")
 assert.equal(manager.getConnectionStatus().lastDisconnectCode, null)
 const newPairing = manager.requestQr()
 manager.sockets[1].ev.emit("connection.update", { qr: "fresh-after-explicit-restart" })
 assert.equal((await newPairing).qr, "fresh-after-explicit-restart")
 assert.equal(manager.archivedPaths.length, 1)
 assert.equal(manager.timers.size, 0)
})

test("shutdown alone during an in-flight auth rename preserves the backup and stays stopped", async () => {
 const rename = deferred()
 const manager = loadSocket({ rename: () => rename.promise })
 await manager.startWhatsApp()
 close(manager.sockets[0], reasons.loggedOut)
 const pairing = manager.requestQr()
 await settle()
 assert.equal(manager.archivedPaths.length, 1)
 manager.stopWhatsApp()
 assert.equal((await pairing).state, "stopped")
 rename.resolve()
 await settle()
 assert.equal(manager.getConnectionStatus().state, "stopped")
 assert.equal(manager.authCalls, 1)
 assert.equal(manager.sockets.length, 1)
 assert.equal(manager.archivedPaths.length, 1)
 assert.equal(manager.timers.size, 0)
})

test("another shutdown cancels an explicit restart queued behind an auth rename", async () => {
 const rename = deferred()
 const manager = loadSocket({ rename: () => rename.promise })
 await manager.startWhatsApp()
 close(manager.sockets[0], reasons.loggedOut)
 const pairing = manager.requestQr()
 await settle()
 manager.stopWhatsApp()
 await pairing
 const restart = manager.startWhatsApp()
 manager.stopWhatsApp()
 rename.resolve()
 assert.equal(await restart, null)
 await settle()
 assert.equal(manager.getConnectionStatus().state, "stopped")
 assert.equal(manager.authCalls, 1)
 assert.equal(manager.sockets.length, 1)
 assert.equal(manager.archivedPaths.length, 1)
 assert.equal(manager.timers.size, 0)
})

test("starting during active auth archival joins the automatically started replacement", async () => {
 const rename = deferred()
 const manager = loadSocket({ rename: () => rename.promise })
 await manager.startWhatsApp()
 close(manager.sockets[0], reasons.loggedOut)
 const pairing = manager.requestQr()
 await settle()
 const start = manager.startWhatsApp()
 assert.equal(manager.startWhatsApp(), start)
 rename.resolve()
 assert.equal(await start, manager.sockets[1])
 assert.equal(manager.sockets.length, 2)
 assert.equal(manager.authCalls, 2)
 manager.sockets[1].ev.emit("connection.update", { qr: "archived-and-started" })
 assert.equal((await pairing).qr, "archived-and-started")
 assert.equal(manager.timers.size, 0)
})
