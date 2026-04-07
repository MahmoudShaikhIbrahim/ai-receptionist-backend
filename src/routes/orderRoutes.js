const express = require("express");
const router = express.Router();
const requireAuth = require("../middleware/authMiddleware");
const Order = require("../models/Order");

// GET /orders
router.get("/", requireAuth, async (req, res) => {
  try {
    const { status, limit = 50, page = 1, tableId } = req.query;
    const query = { businessId: req.businessId };
    if (status) query.status = status;
    if (tableId) query.tableId = tableId;

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

// POST /orders/table — create or add round to existing table order
router.post("/table", requireAuth, async (req, res) => {
  try {
    const { tableId, tableLabel, items, customerName, notes } = req.body;

    if (!tableId || !items?.length) {
      return res.status(400).json({ error: "tableId and items are required" });
    }

    const roundItems = items.map(i => ({
      name: i.name,
      quantity: i.quantity || 1,
      price: i.price || 0,
      extras: i.extras || [],
      notes: i.notes || null,
    }));

    const roundTotal = roundItems.reduce((sum, i) => sum + i.price * i.quantity, 0);

    // Check if there's already an open order for this table
    const existing = await Order.findOne({
      businessId: req.businessId,
      tableId,
      status: { $in: ["confirmed", "preparing", "ready"] },
    });

    if (existing) {
      // Add new round to existing order
      existing.rounds.push({ items: roundItems, sentAt: new Date(), notes: notes || null });
      existing.items.push(...roundItems);
      existing.total = (existing.total || 0) + roundTotal;
      if (customerName) existing.customerName = customerName;
      await existing.save();
      return res.json({ order: existing, isNewRound: true });
    }

    // Create new order
    const order = await Order.create({
      callId: `table_${tableId}_${Date.now()}`,
      businessId: req.businessId,
      tableId,
      tableLabel,
      customerName: customerName || "Walk-in",
      orderType: "dineIn",
      items: roundItems,
      rounds: [{ items: roundItems, sentAt: new Date(), notes: notes || null }],
      total: roundTotal,
      status: "confirmed",
    });

    res.status(201).json({ order, isNewRound: false });
  } catch (err) {
    console.error("POST /orders/table error:", err);
    res.status(500).json({ error: "Failed to create table order" });
  }
});

// GET /orders/table/:tableId — get active order for a table
router.get("/table/:tableId", requireAuth, async (req, res) => {
  try {
    const order = await Order.findOne({
      businessId: req.businessId,
      tableId: req.params.tableId,
      status: { $in: ["confirmed", "preparing", "ready"] },
    }).lean();

    res.json({ order });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch table order" });
  }
});

module.exports = router;