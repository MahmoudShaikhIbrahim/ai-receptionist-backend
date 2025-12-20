const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const Agent = require("../models/Agent");

/* ======================
   AUTH MIDDLEWARE
====================== */
function auth(req, res, next) {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ error: "No token" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.businessId = decoded.id;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

/* ======================
   GET /business/agent/me
   Business reads its agent info
====================== */
router.get("/me", auth, async (req, res) => {
  const agent = await Agent.findOne({ businessId: req.businessId });
  if (!agent) return res.status(404).json({ error: "Agent not found" });

  res.json({ agent });
});

/* ======================
   PUT /business/agent
   Business submits change request
====================== */
router.put("/", auth, async (req, res) => {
  const agent = await Agent.findOne({ businessId: req.businessId });
  if (!agent) return res.status(404).json({ error: "Agent not found" });

  const { changeRequestText } = req.body;

  if (typeof changeRequestText !== "string" || !changeRequestText.trim()) {
    return res.status(400).json({
      error: "Change request text is required",
    });
  }

  // Save free-text request (business intent)
  agent.changeRequestText = changeRequestText.trim();
  agent.changeRequestStatus = "pending";
  agent.changeRequestUpdatedAt = new Date();

  await agent.save();

  res.json({
    message: "Change request submitted for admin review",
    agent,
  });
});

module.exports = router;