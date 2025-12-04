const express = require("express");
const router = express.Router();
const Call = require("../models/Call");

// GET all calls (newest first)
router.get("/", async (req, res) => {
  try {
    const calls = await Call.find().sort({ timestamp: -1 });
    res.json(calls);
  } catch (error) {
    console.error("Error fetching calls:", error);
    res.status(500).json({ error: "Failed to fetch calls" });
  }
});

module.exports = router;