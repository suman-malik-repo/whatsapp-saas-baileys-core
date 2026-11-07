// Standalone deployments supply their own secret through the environment.
// Managed mode authenticates through WORKER_SECRET and does not use this key.
module.exports = process.env.API_KEY
