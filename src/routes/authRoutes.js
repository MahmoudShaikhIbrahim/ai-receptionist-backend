// src/routes/authRoutes.js

const express = require("express");
const router = express.Router();
const Agent = require("../models/Agent");
const jwt = require("jsonwebtoken");

// JWT helper
const createToken = (agent) => {
  return jwt.sign(
    { id: agent._id, email: agent.ownerEmail },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
};

// REGISTER AGENT
router.post("/register", async (req, res) => {
  try {
    const { name, businessName, ownerEmail, businessPhoneNumber, password } = req.body;

    const exists = await Agent.findOne({ ownerEmail });
    if (exists) {
      return res.status(400).json({ error: "Email already registered" });
    }

    const agent = await Agent.create({
      name,
      businessName,
      ownerEmail,
      businessPhoneNumber,
      password,
    });

    res.json({ message: "Agent registered successfully" });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// LOGIN AGENT
router.post("/login", async (req, res) => {
  try {
    const { ownerEmail, password } = req.body;

    const agent = await Agent.findOne({ ownerEmail });
    if (!agent) return res.status(400).json({ error: "Invalid email or password" });

    const isMatch = await agent.comparePassword(password);
    if (!isMatch) return res.status(400).json({ error: "Invalid email or password" });

    const token = createToken(agent);

    res.json({
      message: "Login success",
      token,
      agent: {
        id: agent._id,
        name: agent.name,
        businessName: agent.businessName,
        ownerEmail: agent.ownerEmail,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;