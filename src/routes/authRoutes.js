const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");

const Business = require("../models/Business");
const Agent = require("../models/Agent");

/* ======================
   TOKEN HELPER (FIXED)
====================== */
const createToken = (business) => {
  return jwt.sign(
    { businessId: business._id, id: business._id, email: business.email },
    process.env.JWT_SECRET,
    { expiresIn: "30d" }
  );
};

/* ======================
   REGISTER BUSINESS
====================== */
router.post("/register", async (req, res) => {
  try {
    const { businessName, email, password, businessType } = req.body;

    if (!businessName || !email || !password) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const exists = await Business.findOne({ email });
    if (exists) {
      return res.status(400).json({ error: "Email already used" });
    }

    const business = await Business.create({
      businessName,
      email,
      password,
      businessType,
    });

    // CREATE AGENT using ONLY valid schema fields
    const agent = await Agent.create({
      businessId: business._id,
      businessName,
      ownerEmail: email,
      businessPhoneNumber: null,
      businessType,
      openingHours: {},
    });

    const token = createToken(business);

    res.status(201).json({
      message: "Account created",
      token,
      business: {
        id: business._id,
        businessName: business.businessName,
        email: business.email,
      },
      agentId: agent._id,
    });
  } catch (err) {
    console.error("REGISTER ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ======================
   LOGIN
====================== */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const business = await Business.findOne({ email }).select("+password");
    if (!business || !business.password) {
      return res.status(400).json({ error: "Invalid email or password" });
    }

    const correct = await business.comparePassword(password);
    if (!correct) {
      return res.status(400).json({ error: "Invalid email or password" });
    }

    const token = createToken(business);

    res.json({
      message: "Login successful",
      token,
      business: {
        id: business._id,
        businessName: business.businessName,
        email: business.email,
      },
    });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});
module.exports = router;