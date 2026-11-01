const path = require("node:path")
const fs = require("node:fs/promises")
const { randomUUID } = require("node:crypto")
const {
 default: makeWASocket,
 useMultiFileAuthState,
 DisconnectReason,
 proto
} = require("@whiskeysockets/baileys")
const qrcode = require("qrcode-terminal")
const P = require("pino")

let authDirectory = path.join(__dirname, "..", "auth")
let backupDirectory = path.join(__dirname, "..", "auth-backups")
let managedStorage = false
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
const connectionListeners = new Set()
const messageUpdateListeners = new Set()
const messageUpdateHandlers = new WeakMap()
let lastPublishedConnection = null

function callSubscriber(listener, value) {
 try {
  const result = listener({ ...value })
  if (result && typeof result.catch === "function") {
   result.catch(() => console.error("WhatsApp status subscriber failed"))
  }
 } catch {
  console.error("WhatsApp status subscriber failed")
 }
}

function publishConnection() {
 const snapshot = getConnectionStatus()
 const serialized = JSON.stringify(snapshot)
 if (serialized === lastPublishedConnection) return
 lastPublishedConnection = serialized
 for (const listener of [...connectionListeners]) callSubscriber(listener, snapshot)
}

function subscribeConnection(listener) {
 if (typeof listener !== "function") throw new TypeError("Connection subscriber must be a function")
 connectionListeners.add(listener)
 callSubscriber(listener, getConnectionStatus())
 return () => connectionListeners.delete(listener)
}

function subscribeMessageUpdates(listener) {
 if (typeof listener !== "function") throw new TypeError("Message subscriber must be a function")
 messageUpdateListeners.add(listener)
 return () => messageUpdateListeners.delete(listener)
}

function publishMessageUpdate(key, status) {
 // Only acknowledgements for outbound messages can advance a queued send.
 // Do not expose the raw Baileys event, participant data, or message content.
 if (key?.fromMe !== true || typeof key.id !== "string" || !/^[A-Za-z0-9_.-]{1,256}$/.test(key.id)) return
 const update = { messageId: key.id, status }
 if (typeof key.remoteJid === "string" && key.remoteJid.length <= 256 && !/[\s\x00-\x1f\x7f]/.test(key.remoteJid)) {
  update.remoteJid = key.remoteJid
 }
 for (const listener of [...messageUpdateListeners]) callSubscriber(listener, update)
}

function hasReceiptTimestamp(value) {
 try {
  const timestamp = typeof value === "number" ? value : value?.toNumber?.()
  return Number.isFinite(timestamp) && timestamp > 0
 } catch {
  return false
 }
}

function attachMessageUpdates(currentSocket, isCurrent) {
 const statuses = proto.WebMessageInfo.Status
 const onMessagesUpdate = (updates) => {
  if (!isCurrent() || !Array.isArray(updates)) return
  for (const entry of updates) {
   if (!isCurrent()) break
   const status = entry?.update?.status
   if (status === statuses.READ || status === statuses.PLAYED) publishMessageUpdate(entry.key, "read")
   else if (status === statuses.DELIVERY_ACK) publishMessageUpdate(entry.key, "delivered")
   // ERROR and SERVER_ACK do not prove recipient delivery or a safe resend.
  }
 }
 const onReceiptUpdate = (updates) => {
  if (!isCurrent() || !Array.isArray(updates)) return
  for (const entry of updates) {
   if (!isCurrent()) break
   const receipt = entry?.receipt
   if (hasReceiptTimestamp(receipt?.readTimestamp) || hasReceiptTimestamp(receipt?.playedTimestamp)) {
    publishMessageUpdate(entry.key, "read")
   } else if (hasReceiptTimestamp(receipt?.receiptTimestamp)) publishMessageUpdate(entry.key, "delivered")
  }
 }
 currentSocket.ev.on("messages.update", onMessagesUpdate)
 currentSocket.ev.on("message-receipt.update", onReceiptUpdate)
 messageUpdateHandlers.set(currentSocket, { onMessagesUpdate, onReceiptUpdate })
}

function detachMessageUpdates(currentSocket) {
 const handlers = messageUpdateHandlers.get(currentSocket)
 if (!handlers) return
 messageUpdateHandlers.delete(currentSocket)
 currentSocket.ev.off("messages.update", handlers.onMessagesUpdate)
 currentSocket.ev.off("message-receipt.update", handlers.onReceiptUpdate)
}

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
 detachMessageUpdates(currentSocket)
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
  publishConnection()
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
 publishConnection()
}

function startWhatsApp() {
 if (credentialsFailed) return Promise.resolve(null)
 if (authMaintenance) {
  if (maintenanceStart && running && maintenanceStart.generation === generation) return maintenanceStart.promise
  if (!running) {
   running = true
   state = "connecting"
   generation += 1
   publishConnection()
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
 publishConnection()
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
  attachMessageUpdates(currentSocket, isCurrent)

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
    publishConnection()
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
    if (!managedStorage) {
     console.log("Scan the WhatsApp QR code in this terminal")
     qrcode.generate(update.qr, { small: true })
    }
    finishQrRequests()
   } else if (update.connection === "connecting" && !qr) {
    state = "connecting"
   }
   publishConnection()
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
 publishConnection()
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
  publishConnection()
  const maintenance = Promise.resolve(previousInitialization).then(async () => {
   await credentialsQueue
   if (!running || attempt !== generation || credentialsFailed) return false
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
   publishConnection()
   if (!running || attempt !== generation || credentialsFailed) return false
   return true
  }).catch(() => {
   if (running && attempt === generation) {
    state = "failed"
    clearQr()
    publishConnection()
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
  publishConnection()
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
    publishConnection()
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

function configureStorage({ dataDir, managed = false }) {
 if (running || socket || initialization || authMaintenance) throw new Error("Cannot change storage while WhatsApp is running")
 if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) throw new Error("DATA_DIR must be an absolute path")
 const directory = path.resolve(dataDir)
 authDirectory = path.join(directory, "auth")
 backupDirectory = path.join(directory, "auth-backups")
 managedStorage = managed
}

async function resetWhatsApp() {
 // Never delete a still-linked account when remote revocation is unconfirmed.
 // Offline linked workers remain quarantined until an operator recovers them.
 await initialization
 if (managedStorage && !activeAuth) {
  try {
   const stored = JSON.parse(await fs.readFile(path.join(authDirectory, "creds.json"), "utf8"))
   linkedSession = Boolean(stored.registered || stored.me?.id)
  } catch (error) { if (error.code !== "ENOENT") throw error }
 }
 if (linkedSession && lastDisconnectCode !== DisconnectReason.loggedOut) {
  // Managed callers have already confirmed this disk's assignment. Reconnect
  // solely to obtain server-confirmed revocation during operator recovery.
  if (!socket && managedStorage) await startWhatsApp()
  if (!socket || typeof socket.logout !== "function") throw new Error("Linked WhatsApp account cannot be revoked while offline")
  let timeout
  try {
   await Promise.race([socket.logout(), new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error("WhatsApp logout timed out")), 15000)
   })])
  } finally { if (timeout) clearTimeout(timeout) }
 }
 await stopWhatsApp()
 await initialization
 await credentialsQueue
 if (authMaintenance) await authMaintenance
 // Both targets are fixed children of the configured data root, never request
 // paths. Check the resolved relationship before recursively removing either.
 const root = path.dirname(authDirectory)
 for (const directory of [authDirectory, backupDirectory]) {
  if (path.dirname(path.resolve(directory)) !== root || !["auth", "auth-backups"].includes(path.basename(directory))) throw new Error("Invalid WhatsApp storage target")
  await fs.rm(directory, { recursive: true, force: true })
 }
 activeAuth = null; linkedSession = false; pairingInProgress = false
 socketHasQr = false; lastDisconnectCode = null; reconnectAttempts = 0
 credentialsFailed = false; refreshingGeneration = null
 publishConnection()
}

module.exports = {
 startWhatsApp, stopWhatsApp, getSocket, getConnectionStatus, getQrStatus, requestQr,
 subscribeConnection, subscribeMessageUpdates, configureStorage, resetWhatsApp
}
