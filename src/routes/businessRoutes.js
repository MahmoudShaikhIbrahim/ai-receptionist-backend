// src/routes/businessRoutes.js
const express = require("express");
const router = express.Router();

const requireAuth = require("../middleware/authMiddleware");
const Business = require("../models/Business");
const Agent = require("../models/Agent");
const { getBusinessCalls } = require("../controllers/callController");

/* ======================
   GET /business/me
====================== */
router.get("/me", requireAuth, async (req, res) => {
  try {
    const business = await Business.findById(req.businessId).lean();
    if (!business) {
      return res.status(404).json({ error: "Business not found" });
    }

    const agent = await Agent.findOne({ businessId: req.businessId }).lean();

    res.json({ business, agent });
  } catch (err) {
    console.error("GET /business/me error:", err);
    res.status(500).json({ error: "Failed to fetch business data" });
  }
});

/* ======================
   GET /business/calls
====================== */
router.get("/calls", requireAuth, getBusinessCalls);

/* ======================
   PUT /business/profile
====================== */
router.put("/profile", requireAuth, async (req, res) => {
  try {
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
  } catch (err) {
    console.error("PUT /business/profile error:", err);
    res.status(500).json({ error: "Failed to update business profile" });
  }
});

/* ======================
   PUT /business/hours
====================== */
router.put("/hours", requireAuth, async (req, res) => {
  try {
    const agent = await Agent.findOne({ businessId: req.businessId });
    if (!agent) {
      return res.status(404).json({ error: "Agent not found" });
    }

    agent.openingHours = req.body;
    await agent.save();

    res.json({ openingHours: agent.openingHours });
  } catch (err) {
    console.error("PUT /business/hours error:", err);
    res.status(500).json({ error: "Failed to update opening hours" });
  }
});

module.exports = router;