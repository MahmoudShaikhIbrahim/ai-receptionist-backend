const express = require("express");
const router = express.Router();
const requireAuth = require("../middleware/authMiddleware");
const Order = require("../models/Order");

// GET /orders
router.get("/", requireAuth, async (req, res) => {
  try {
    const { status, limit = 50, page = 1 } = req.query;
    const query = { businessId: req.businessId };
    if (status) query.status = status;

    const orders = await Order.find(query)
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .skip((Number(page) - 1) * Number(limit))
      .lean();

    const total = await Order.countDocuments(query);

    res.json({ orders, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch orders" });
  }
});

// PATCH /orders/:id/status
router.patch("/:id/status", requireAuth, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!order) return res.status(404).json({ error: "Order not found" });
    order.status = req.body.status;
    await order.save();
    res.json({ order });
  } catch (err) {
    res.status(500).json({ error: "Failed to update order status" });
  }
});

module.exports = router;