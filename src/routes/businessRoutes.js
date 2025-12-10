// src/routes/businessRoutes.js

const express = require("express");
const Business = require("../models/Business");
const Agent = require("../models/Agent");
const { requireAuth } = require("../middleware/authMiddleware");

const router = express.Router();

// All routes here require authentication
router.use(requireAuth);

// GET /business/me  → business profile + agent
router.get("/me", async (req, res) => {
  try {
    const business = await Business.findById(req.business.id).lean();
    if (!business) {
      return res.status(404).json({ error: "Business not found" });
    }

    let agent = null;
    if (business.agentId) {
      agent = await Agent.findById(business.agentId).lean();
    } else {
      agent = await Agent.findOne({ businessId: business._id }).lean();
    }

    res.json({
      business: {
        id: business._id,
        businessName: business.businessName,
        email: business.email,
        businessType: business.businessType,
        ownerName: business.ownerName,
        businessPhone: business.businessPhone,
        timezone: business.timezone,
        languagePreference: business.languagePreference,
      },
      agent,
    });
  } catch (err) {
    console.error("GET /business/me error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Later we’ll add:
// PUT /business/me  → update settings
// PUT /business/me/agent → update agent config

module.exports = router;