// src/controllers/agentController.js
const Agent = require("../models/Agent");

exports.getMe = async (req, res) => {
  const agent = await Agent.findOne({ businessId: req.businessId });
  if (!agent) {
    return res.status(404).json({ error: "Agent not found" });
  }
  res.json({ agent });
};

exports.updateAgent = async (req, res) => {
  const agent = await Agent.findOne({ businessId: req.businessId });

  if (!agent) {
    return res.status(404).json({ error: "Agent not found" });
  }

  // what your UI sends: “make him say Hi instead of Hey”
  agent.changeRequest = req.body.changeRequest;

  await agent.save();

  res.json({
    message: "Change request submitted",
  });
};

exports.updateOpeningHours = async (req, res) => {
  const agent = await Agent.findOne({ businessId: req.businessId });

  if (!agent) {
    return res.status(404).json({ error: "Agent not found" });
  }

  agent.openingHours = req.body;
  await agent.save();

  res.json({
    message: "Opening hours updated",
    openingHours: agent.openingHours,
  });
};