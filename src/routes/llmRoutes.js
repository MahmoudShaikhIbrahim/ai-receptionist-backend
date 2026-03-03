// src/routes/llmRoutes.js

const express = require("express");
const router = express.Router();
const { respond } = require("../controllers/llmController");
const CallSession = require("../models/CallSession");

// POST endpoint (Retell Custom LLM - Polling mode)
router.post("/respond", express.json({ limit: "2mb" }), respond);

// GET endpoint (Retell polling)
router.get("/respond/:callId", async (req, res) => {
  try {
    const { callId } = req.params;

    const session = await CallSession.findOne({ callId });

    if (!session || !session.lastAssistantText) {
      return res.json({ status: "pending" });
    }

    return res.json({
      response: {
        text: session.lastAssistantText,
      },
    });
  } catch (err) {
    console.error("GET poll error:", err);
    return res.json({ status: "pending" });
  }
});

module.exports = router;