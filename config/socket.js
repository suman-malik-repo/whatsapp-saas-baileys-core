const path = require("node:path")
const fs = require("node:fs/promises")
const { randomUUID } = require("node:crypto")
const {
 default: makeWASocket,
 useMultiFileAuthState,
 DisconnectReason
} = require("@whiskeysockets/baileys")
const qrcode = require("qrcode-terminal")
const P = require("pino")

const authDirectory = path.join(__dirname, "..", "auth")
const qrLifetimeMs = 20000
const terminalDisconnects = new Set([
 DisconnectReason.loggedOut,
 DisconnectReason.badSession,
 DisconnectReason.connectionReplaced,
 DisconnectReason.forbidden,
 DisconnectReason.multideviceMismatch
])

let socket = null
let initialization = null
let initializationGeneration = null
let credentialsQueue = Promise.resolve()
let credentialsFailed = false
let reconnectTimer = null
let running = false
let generation = 0
let state = "stopped"
let reconnectAttempts = 0
let nextRetryAt = null
let lastDisconnectCode = null
let activeAuth = null
let linkedSession = false
let pairingInProgress = false
let socketHasQr = false
let refreshingGeneration = null
let qr = null
let qrGeneratedAt = null
let qrExpiresAt = null
let qrRequest = null
let qrPreparation = null
let authMaintenance = null
let maintenanceStart = null
const qrWaiters = new Set()

function clearQr() {
 qr = null
 qrGeneratedAt = null
 qrExpiresAt = null
}

function getQrStatus() {
 if (qrExpiresAt !== null && Date.now() >= qrExpiresAt) clearQr()
 return {
  state,
  connected: state === "connected" && socket !== null,
  qr,
  generatedAt: qrGeneratedAt === null ? null : new Date(qrGeneratedAt).toISOString(),
  expiresAt: qrExpiresAt === null ? null : new Date(qrExpiresAt).toISOString()
 }
}

function finishQrRequests() {
 for (const finish of [...qrWaiters]) finish()
}

function disconnectCode(error) {
 const code = error?.output?.statusCode ?? error?.statusCode
 return Number.isInteger(code) ? code : null
}

function closeTransport(currentSocket) {
 if (!currentSocket) return
 try {
  // end closes this connection without revoking the linked WhatsApp session.
  const closing = currentSocket.end(new Error("WhatsApp connection closed locally"))
  if (closing && typeof closing.catch === "function") closing.catch(() => {})
 } catch {
  console.error("Could not close the WhatsApp transport cleanly")
 }
}

function clearReconnect() {
 if (reconnectTimer !== null) clearTimeout(reconnectTimer)
 reconnectTimer = null
 nextRetryAt = null
}

function scheduleReconnect(code) {
 if (!running || credentialsFailed || reconnectTimer !== null) return

 if (terminalDisconnects.has(code)) {
  state = code === DisconnectReason.loggedOut ? "logged_out" : "failed"
  console.error("WhatsApp connection requires manual attention; disconnect code:", code)
  finishQrRequests()
  return
 }

 reconnectAttempts += 1
 const backoff = Math.min(30000, 1000 * 2 ** Math.min(reconnectAttempts - 1, 5))
 const delay = code === DisconnectReason.restartRequired
  ? 250
  : Math.min(30000, Math.round(backoff * (0.8 + Math.random() * 0.4)))

 state = "reconnecting"
 nextRetryAt = new Date(Date.now() + delay).toISOString()
 reconnectTimer = setTimeout(() => {
  reconnectTimer = null
  nextRetryAt = null
  if (running) void startWhatsApp()
 }, delay)
}

function startWhatsApp() {
 if (credentialsFailed) return Promise.resolve(null)
 if (authMaintenance) {
  if (maintenanceStart && running && maintenanceStart.generation === generation) return maintenanceStart.promise
  if (!running) {
   running = true
   state = "connecting"
   generation += 1
  }
  const requestedGeneration = generation
  const pendingStart = authMaintenance.then(() => {
   // Successful maintenance can already have started the next socket. Preserve
   // this caller's intent across that socket generation, but cancel it when
   // shutdown clears or replaces the queued request.
   if (!running || maintenanceStart?.promise !== pendingStart || credentialsFailed) return null
   return startWhatsApp()
  }).finally(() => {
   if (maintenanceStart?.promise === pendingStart) maintenanceStart = null
  })
  maintenanceStart = { generation: requestedGeneration, promise: pendingStart }
  return pendingStart
 }
 if (initialization && running && initializationGeneration === generation) return initialization
 if (socket || reconnectTimer !== null) return Promise.resolve(socket)

 running = true
 state = "connecting"
 clearQr()
 socketHasQr = false
 refreshingGeneration = null
 const attempt = ++generation
 const previousInitialization = initialization
 initializationGeneration = attempt

 const currentInitialization = Promise.resolve(previousInitialization).then(async () => {
  // An old connection may still be persisting the credentials that triggered
  // its close. Finish those writes before loading a replacement auth state.
  await credentialsQueue
  if (!running || attempt !== generation || credentialsFailed) return null
  const { state: auth, saveCreds } = await useMultiFileAuthState(authDirectory)
  if (!running || attempt !== generation || credentialsFailed) return null
  activeAuth = auth
  linkedSession = Boolean(auth.creds?.registered || auth.creds?.me?.id)

  // Use the installed Baileys protocol defaults instead of making a version
  // lookup a new network dependency on every reconnect.
  const currentSocket = makeWASocket({
   auth,
   qrTimeout: qrLifetimeMs,
   logger: P({ level: "silent" }),
   browser: ["Chrome", "Desktop", "1.0"]
  })
  socket = currentSocket
  const isCurrent = () => running && attempt === generation && socket === currentSocket

  currentSocket.ev.on("creds.update", (update) => {
   if (!isCurrent()) return
   if (update?.registered || update?.me?.id) {
    linkedSession = true
    if (state !== "connected") pairingInProgress = true
    clearQr()
   }
   // Accept only current-socket events, then preserve every accepted write
   // even if a close or shutdown happens before this queued task runs.
   credentialsQueue = credentialsQueue.then(() => saveCreds()).catch(() => {
    credentialsFailed = true
    generation += 1
    clearReconnect()
    const failedSocket = socket
    socket = null
    clearQr()
    if (running) state = "failed"
    finishQrRequests()
    closeTransport(failedSocket)
    // Do not reconnect using credentials that failed to persist. Fix storage
    // and restart the server before allowing sends again.
    console.error("WhatsApp credentials could not be saved; fix storage and restart the server")
   })
  })

  currentSocket.ev.on("connection.update", (update) => {
   if (!isCurrent()) return

   if (update.connection === "close") {
    lastDisconnectCode = disconnectCode(update.lastDisconnect?.error)
    socket = null
    clearQr()
    closeTransport(currentSocket)
    scheduleReconnect(lastDisconnectCode)
    return
   }

   if (update.connection === "open") {
    state = "connected"
    linkedSession = true
    pairingInProgress = false
    clearQr()
    reconnectAttempts = 0
    nextRetryAt = null
    console.log("WhatsApp Connected Successfully")
    finishQrRequests()
   } else if (update.isNewLogin) {
    linkedSession = true
    pairingInProgress = true
    clearQr()
    state = "connecting"
   } else if (typeof update.qr === "string" && update.qr && !pairingInProgress && !linkedSession && refreshingGeneration !== attempt) {
    qr = update.qr
    qrGeneratedAt = Date.now()
    qrExpiresAt = qrGeneratedAt + qrLifetimeMs
    socketHasQr = true
    state = "qr_required"
    console.log("Scan the WhatsApp QR code in this terminal")
    qrcode.generate(update.qr, { small: true })
    finishQrRequests()
   } else if (update.connection === "connecting" && !qr) {
    state = "connecting"
   }
  })

  return currentSocket
 }).catch((error) => {
  if (!running || attempt !== generation || credentialsFailed) return null
  const failedSocket = socket
  socket = null
  clearQr()
  closeTransport(failedSocket)
  lastDisconnectCode = disconnectCode(error)
  console.error("WhatsApp connection could not be initialized")
  scheduleReconnect(lastDisconnectCode)
  return null
 }).finally(() => {
  if (initialization === currentInitialization) initialization = null
 })

 initialization = currentInitialization
 return initialization
}

function stopWhatsApp() {
 running = false
 generation += 1
 maintenanceStart = null
 clearReconnect()
 const currentSocket = socket
 socket = null
 clearQr()
 state = "stopped"
 finishQrRequests()
 closeTransport(currentSocket)
 return credentialsQueue
}

async function prepareQr(fresh) {
 if (!running || credentialsFailed || state === "connected") return

 const canReplaceAuth = lastDisconnectCode === DisconnectReason.loggedOut || lastDisconnectCode === DisconnectReason.badSession
 if (terminalDisconnects.has(lastDisconnectCode)) {
  if (!fresh || !canReplaceAuth) return

  // Only explicitly requested pairing replaces credentials known to be unusable.
  // Keep the entire old directory for recovery instead of deleting session files.
  const attempt = ++generation
  const previousInitialization = initialization
  clearReconnect()
  clearQr()
  state = "connecting"
  const maintenance = Promise.resolve(previousInitialization).then(async () => {
   await credentialsQueue
   if (!running || attempt !== generation || credentialsFailed) return false
   const backupDirectory = path.join(__dirname, "..", "auth-backups")
   await fs.mkdir(backupDirectory, { recursive: true })
   if (!running || attempt !== generation || credentialsFailed) return false
   const backupPath = path.join(backupDirectory, `${Date.now()}-${randomUUID()}`)
   try {
    await fs.rename(authDirectory, backupPath)
   } catch (error) {
    if (error.code !== "ENOENT") throw error
   }
   // A rename already in flight can finish after shutdown. Record that the old
   // auth location is now empty, while leaving shutdown/start intent untouched.
   activeAuth = null
   linkedSession = false
   pairingInProgress = false
   lastDisconnectCode = null
   reconnectAttempts = 0
   if (!running || attempt !== generation || credentialsFailed) return false
   return true
  }).catch(() => {
   if (running && attempt === generation) {
    state = "failed"
    clearQr()
    finishQrRequests()
    console.error("WhatsApp session could not be archived; repair storage before pairing")
   }
   return false
  }).finally(() => {
   if (authMaintenance === maintenance) authMaintenance = null
  })
  authMaintenance = maintenance
  if (await maintenance && running && attempt === generation && !credentialsFailed) await startWhatsApp()
  return
 }

 // A saved session and a scanned pairing must finish connecting; requesting a
 // QR never logs out a linked device or interrupts its pairing restart.
 if (pairingInProgress || linkedSession || activeAuth?.creds?.registered || activeAuth?.creds?.me?.id) return

 if (fresh && socket && socketHasQr) {
  const attempt = generation
  const previousSocket = socket
  refreshingGeneration = attempt
  clearQr()
  // Keep accepting credential events while existing writes drain, but ignore
  // old QR rotations so they cannot satisfy a request for a replacement code.
  await credentialsQueue
  if (!running || attempt !== generation || credentialsFailed) return
  // The old socket may have disconnected while its writes drained. Its close
  // handler now owns recovery, including terminal failures requiring a new
  // explicit pairing request; do not turn this old refresh into another start.
  if (socket !== previousSocket || terminalDisconnects.has(lastDisconnectCode)) {
   refreshingGeneration = null
   return
  }
  if (pairingInProgress || linkedSession || activeAuth?.creds?.registered || activeAuth?.creds?.me?.id) {
   refreshingGeneration = null
   return
  }
  generation += 1
  socket = null
  clearReconnect()
  state = "connecting"
  closeTransport(previousSocket)
 }

 if (!socket && reconnectTimer === null) await startWhatsApp()
}

function requestQr({ fresh = true, timeoutMs = 15000 } = {}) {
 const snapshot = getQrStatus()
 const recoverableAuth = lastDisconnectCode === DisconnectReason.loggedOut || lastDisconnectCode === DisconnectReason.badSession
 if (!running || credentialsFailed || snapshot.connected || (terminalDisconnects.has(lastDisconnectCode) && (!fresh || !recoverableAuth))) {
  return Promise.resolve(snapshot)
 }
 if (qrRequest) return qrRequest
 if (!fresh && snapshot.qr) return Promise.resolve(snapshot)

 const waitMs = Number.isFinite(timeoutMs) ? Math.max(0, Math.min(30000, timeoutMs)) : 15000
 let resolveRequest
 const request = new Promise((resolve) => { resolveRequest = resolve })
 qrRequest = request
 let timer = null
 const finish = () => {
  if (!qrWaiters.delete(finish)) return
  if (timer !== null) clearTimeout(timer)
  if (qrRequest === request) qrRequest = null
  resolveRequest(getQrStatus())
 }
 qrWaiters.add(finish)
 timer = setTimeout(finish, waitMs)

 if (!qrPreparation) {
  const preparation = prepareQr(fresh).catch(() => {
   if (running && !credentialsFailed) {
    state = "failed"
    clearQr()
    finishQrRequests()
   }
  }).finally(() => {
   if (qrPreparation === preparation) qrPreparation = null
  })
  qrPreparation = preparation
 }
 return request
}

function getSocket() {
 return state === "connected" ? socket : null
}

function getConnectionStatus() {
 return {
  state,
  connected: state === "connected" && socket !== null,
  reconnectAttempts,
  nextRetryAt,
  lastDisconnectCode
 }
}

module.exports = { startWhatsApp, stopWhatsApp, getSocket, getConnectionStatus, getQrStatus, requestQr }
