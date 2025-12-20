const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");

const Business = require("../models/Business");
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
   GET /business/me
   Returns business + agent (read-only)
====================== */
router.get("/me", auth, async (req, res) => {
  const business = await Business.findById(req.businessId);
  const agent = await Agent.findOne({ businessId: req.businessId });

  if (!business) {
    return res.status(404).json({ error: "Business not found" });
  }

  res.json({ business, agent });
});

/* ======================
   PUT /business/profile
   Update BUSINESS profile only
====================== */
router.put("/profile", auth, async (req, res) => {
  const business = await Business.findById(req.businessId);
  if (!business) {
    return res.status(404).json({ error: "Business not found" });
  }

  const fields = [
    "businessName",
    "ownerPhoneNumber",
    "businessPhoneNumber",
  ];

  fields.forEach((f) => {
    if (req.body[f] !== undefined) {
      business[f] = req.body[f];
    }
  });

  await business.save();

  res.json({
    message: "Business profile updated",
    business,
  });
});

/* ======================
   PUT /business/hours
   Update opening hours (Agent-owned)
====================== */
router.put("/hours", auth, async (req, res) => {
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
});

module.exports = router;