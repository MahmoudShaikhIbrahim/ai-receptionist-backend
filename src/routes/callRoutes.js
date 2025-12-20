// src/routes/callRoutes.js

const express = require("express");
const router = express.Router();
const Call = require("../models/Call");

/* ======================
   GET ALL CALLS
   ADMIN ONLY (for now)
====================== */
router.get("/", async (_req, res) => {
  try {
    const calls = await Call.find().sort({ timestamp: -1 });
    res.json(calls);
  } catch (error) {
    console.error("Error fetching calls:", error);
    res.status(500).json({ error: "Failed to fetch calls" });
  }
});

module.exports = router;