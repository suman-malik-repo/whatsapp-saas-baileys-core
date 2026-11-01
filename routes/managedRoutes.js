const express = require("express")
const { createAuthenticator, managedError } = require("../services/managedProtocol")

function createManagedRouter(worker) {
 const router = express.Router()
 router.use(express.json({ limit: "64kb", verify(req, _res, buffer) { req.rawBody = buffer } }))
 router.use(createAuthenticator({ workerId: worker.workerId, secret: worker.secret }))
 router.use((req, res, next) => {
  if (req.method === "POST" && (!req.is("application/json") || !req.body || typeof req.body !== "object" || Array.isArray(req.body))) return res.status(400).json({ error: "A JSON object is required" })
  next()
 })
 router.get("/capabilities", (_req, res) => res.json({ ...worker.capabilities(), readiness: worker.readiness() }))
 router.post("/assignment", async (req, res) => res.json(await worker.assign(req.body)))
 router.post("/pairing", async (req, res) => res.json(await worker.pairing(req.body)))
 router.get("/qr", async (req, res) => res.json(await worker.qr({ assignmentId: req.query.assignmentId, fence: Number(req.query.fence) })))
 router.post("/reset", async (req, res) => res.json(await worker.reset(req.body)))
 router.post("/jobs/dispatch", async (req, res) => res.status(202).json(await worker.dispatch(req.body)))
 router.get("/jobs/:id", (req, res) => {
  const job = worker.job(req.params.id, { assignmentId: req.query.assignmentId, fence: Number(req.query.fence) })
  if (!job) throw managedError(404, "JOB_NOT_FOUND", "Job not found")
  res.json(job)
 })
 router.post("/media/inspect", async (req, res) => res.json(await worker.inspect(req.body)))
 router.post("/media/import", async (req, res) => res.json(await worker.inspect(req.body, true)))
 return router
}
module.exports = { createManagedRouter }
