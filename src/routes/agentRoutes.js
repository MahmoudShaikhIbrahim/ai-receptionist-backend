// src/routes/agentRoutes.js

const express = require("express");
const router = express.Router();
const Agent = require("../models/Agent");

/* ======================
   CREATE AGENT (ADMIN ONLY)
   Called once during onboarding
====================== */
router.post("/", async (req, res) => {
  try {
    const {
      businessId,
      businessName,
      ownerEmail,
      businessPhoneNumber,
      retellAgentId,
      retellAgentName,
    } = req.body;

    if (!businessId || !businessName || !retellAgentId) {
      return res.status(400).json({
        error: "businessId, businessName and retellAgentId are required",
      });
    }

    const agent = await Agent.create({
      businessId,
      businessName,
      ownerEmail,
      businessPhoneNumber,
      retellAgentId,
      retellAgentName,
      changeRequestStatus: "none",
    });

    res.status(201).json(agent);
  } catch (error) {
    console.error("Error creating agent:", error);
    res.status(500).json({ error: "Failed to create agent" });
  }
});

/* ======================
   GET ALL AGENTS (ADMIN)
====================== */
router.get("/", async (_req, res) => {
  try {
    const agents = await Agent.find().sort({ createdAt: -1 });
    res.json(agents);
  } catch (error) {
    console.error("Error fetching agents:", error);
    res.status(500).json({ error: "Failed to fetch agents" });
  }
});

/* ======================
   GET AGENT BY ID (ADMIN)
====================== */
router.get("/:id", async (req, res) => {
  try {
    const agent = await Agent.findById(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: "Agent not found" });
    }
    res.json(agent);
  } catch (error) {
    console.error("Error fetching agent:", error);
    res.status(500).json({ error: "Failed to fetch agent" });
  }
});

module.exports = router;