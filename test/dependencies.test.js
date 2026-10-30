const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")

// Exercise the installed library without creating a socket or loading the
// application's WhatsApp session. The app uses CommonJS on Node 24.
test("installed Baileys exposes the CommonJS API used by the server", () => {
 const baileys = require("@whiskeysockets/baileys")
 assert.equal(typeof baileys.default, "function")
 assert.equal(baileys.default, baileys.makeWASocket)
 assert.equal(typeof baileys.useMultiFileAuthState, "function")
 for (const reason of [
  "loggedOut", "badSession", "connectionReplaced", "forbidden",
  "multideviceMismatch", "restartRequired"
 ]) {
  assert.ok(Number.isInteger(baileys.DisconnectReason[reason]), reason)
 }
})

test("installed WhatsApp protobuf preserves outgoing message text and ID", () => {
 const { proto } = require("@whiskeysockets/baileys")
 const fixture = {
  key: {
   id: "OFFLINE-DEPENDENCY-TEST",
   remoteJid: "offline-test@s.whatsapp.net",
   fromMe: true
  },
  message: { conversation: "Offline test: hello \uD83D\uDC4B" }
 }
 const encoded = proto.WebMessageInfo.encode(proto.WebMessageInfo.create(fixture)).finish()
 assert.ok(encoded.byteLength > 0)
 const decoded = proto.WebMessageInfo.decode(encoded)
 assert.equal(decoded.key.id, fixture.key.id)
 assert.equal(decoded.key.remoteJid, fixture.key.remoteJid)
 assert.equal(decoded.key.fromMe, true)
 assert.equal(decoded.message.conversation, fixture.message.conversation)
})

test("installed auth storage persists offline credentials and binary signal keys", async (t) => {
 const { useMultiFileAuthState } = require("@whiskeysockets/baileys")
 const tempParent = path.resolve(os.tmpdir())
 const prefix = "baileys-dependency-test-"
 const authDirectory = await fs.mkdtemp(path.join(tempParent, prefix))
 t.after(async () => {
  // Delete only the exact temporary directory this test created.
  assert.equal(path.dirname(authDirectory), tempParent)
  assert.ok(path.basename(authDirectory).startsWith(prefix))
  await fs.rm(authDirectory, { recursive: true, force: true })
 })

 const { state, saveCreds } = await useMultiFileAuthState(authDirectory)
 // These credentials have never been linked to WhatsApp. All storage stays
 // inside the owned OS temp directory, including generated ephemeral keys.
 state.creds.me = { id: "offline-test@s.whatsapp.net", name: "Offline fixture" }
 state.creds.registered = false
 const signalKey = {
  public: Buffer.from("offline-public-fixture"),
  private: Buffer.from("offline-private-fixture")
 }
 await saveCreds()
 await state.keys.set({ "pre-key": { "offline-fixture": signalKey } })

 const restored = await useMultiFileAuthState(authDirectory)
 assert.deepEqual(restored.state.creds.me, state.creds.me)
 assert.equal(restored.state.creds.registered, false)
 assert.ok(Buffer.isBuffer(restored.state.creds.noiseKey.private))
 assert.deepEqual(restored.state.creds.noiseKey, state.creds.noiseKey)
 const restoredKeys = await restored.state.keys.get("pre-key", ["offline-fixture"])
 assert.deepEqual(restoredKeys["offline-fixture"], signalKey)
})
