const express = require("express");
const router = express.Router();
const requireAuth = require("../middleware/authMiddleware");
const Call = require("../models/Call");

// All calls
router.get("/", requireAuth, async (req, res) => {
  const calls = await Call.find({
    businessId: req.business.id,
  }).sort({ createdAt: -1 });

  res.json({ calls });
});

// Bookings
router.get("/bookings", requireAuth, async (req, res) => {
  const bookings = await Call.find({
    businessId: req.business.id,
    "booking.date": { $exists: true },
  }).sort({ createdAt: -1 });

  res.json({ bookings });
});

// Orders
router.get("/orders", requireAuth, async (req, res) => {
  const orders = await Call.find({
    businessId: req.business.id,
    "order.items.0": { $exists: true },
  }).sort({ createdAt: -1 });

  res.json({ orders });
});

module.exports = router;