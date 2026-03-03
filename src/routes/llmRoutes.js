// src/routes/llmRoutes.js
const express = require("express");
const router = express.Router();

const { respond } = require("../controllers/llmController");

// POST endpoint (Retell Custom LLM)
router.post("/respond", express.json({ limit: "2mb" }), respond);

// GET endpoint (Retell will hit this to verify/poll)
router.get("/respond/:callId", (req, res) => {
  return res.json({ status: "ok" });
});

module.exports = router;