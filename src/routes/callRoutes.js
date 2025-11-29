const express = require("express");
const router = express.Router();
const Call = require("../models/Call");

router.get("/", async (req, res) => {
  try {
    const calls = await Call.find().sort({ createdAt: -1 });
    res.json(calls);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch calls" });
  }
});

module.exports = router;