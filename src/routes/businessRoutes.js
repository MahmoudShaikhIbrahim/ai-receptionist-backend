// src/routes/businessRoutes.js
const express = require("express");
const router = express.Router();

const requireAuth = require("../middleware/authMiddleware");
const Business = require("../models/Business");
const Agent = require("../models/Agent");

/* ======================
   GET /business/me
====================== */
router.get("/me", requireAuth, async (req, res) => {
  const business = await Business.findById(req.businessId);
  const agent = await Agent.findOne({ businessId: req.businessId });

  if (!business) {
    return res.status(404).json({ error: "Business not found" });
  }

  res.json({ business, agent });
});

const { getBusinessCalls } = require("../controllers/callController");

// ======================
// GET /business/calls
// ======================
router.get("/calls", requireAuth, getBusinessCalls);

/* ======================
   PUT /business/profile
====================== */
router.put("/profile", requireAuth, async (req, res) => {
  const business = await Business.findById(req.businessId);
  if (!business) {
    return res.status(404).json({ error: "Business not found" });
  }

  const allowed = ["businessName", "businessType"];
  allowed.forEach((key) => {
    if (req.body[key] !== undefined) {
      business[key] = req.body[key];
    }
  });

  await business.save();
  res.json({ business });
});

/* ======================
   PUT /business/hours
====================== */
router.put("/hours", requireAuth, async (req, res) => {
  const agent = await Agent.findOne({ businessId: req.businessId });
  if (!agent) {
    return res.status(404).json({ error: "Agent not found" });
  }

  agent.openingHours = req.body;
  await agent.save();

  res.json({ openingHours: agent.openingHours });
});

module.exports = router;