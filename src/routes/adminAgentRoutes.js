const express = require("express");
const router = express.Router();
const Agent = require("../models/Agent");
const requireAuth = require("../middleware/authMiddleware");

/**
 * ADMIN ONLY – assign Retell Agent ID
 * PUT /admin/agents/:agentId/retell
 */
router.put("/agents/:agentId/retell", requireAuth, async (req, res) => {
  // ⚠️ later you can add admin-role check here
  const { retellAgentId } = req.body;

  if (!retellAgentId || typeof retellAgentId !== "string") {
    return res.status(400).json({ error: "retellAgentId is required" });
  }

  const agent = await Agent.findById(req.params.agentId);
  if (!agent) {
    return res.status(404).json({ error: "Agent not found" });
  }

  agent.retellAgentId = retellAgentId.trim();
  await agent.save();

  res.json({
    message: "Retell agent linked successfully",
    agent,
  });
});

module.exports = router;