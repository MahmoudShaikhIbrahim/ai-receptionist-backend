const express = require("express");
const router = express.Router();
const Call = require("../models/Call");

// GET /calls - fetch all call logs
router.get("/", async (req, res) => {
  console.log("📞 /calls endpoint HIT");

  try {
    const calls = await Call.find().sort({ createdAt: -1 });

    console.log(`📚 Found ${calls.length} calls`);

    return res.status(200).json(calls);
  } catch (error) {
    console.error("❌ Error fetching calls:", error);
    return res.status(500).json({ error: "Failed to fetch calls" });
  }
});

module.exports = router;