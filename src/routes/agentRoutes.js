// src/routes/agentRoutes.js

const express = require("express");
const router = express.Router();
const Agent = require("../models/Agent");

// Create a new agent (admin use for now)
router.post("/", async (req, res) => {
  try {
    const {
      name,
      businessName,
      ownerEmail,
      businessPhoneNumber,
      industry,
      timezone,
      language,
      retellAgentId,
      systemPrompt,
      greetingMessage,
      fallbackMessage,
      closingMessage,
      openingHours,
    } = req.body;

    if (!name || !businessName || !systemPrompt) {
      return res.status(400).json({
        error: "name, businessName and systemPrompt are required",
      });
    }

    const agent = await Agent.create({
      name,
      businessName,
      ownerEmail,
      businessPhoneNumber,
      industry,
      timezone,
      language,
      retellAgentId,
      systemPrompt,
      greetingMessage,
      fallbackMessage,
      closingMessage,
      openingHours,
    });

    res.status(201).json(agent);
  } catch (error) {
    console.error("Error creating agent:", error);
    res.status(500).json({ error: "Failed to create agent" });
  }
});

// Get all agents (later we can filter per user)
router.get("/", async (_req, res) => {
  try {
    const agents = await Agent.find().sort({ createdAt: -1 });
    res.json(agents);
  } catch (error) {
    console.error("Error fetching agents:", error);
    res.status(500).json({ error: "Failed to fetch agents" });
  }
});

// Get one agent by ID
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