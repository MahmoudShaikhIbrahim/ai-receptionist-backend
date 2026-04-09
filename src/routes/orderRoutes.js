// src/routes/orderRoutes.js

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

    // ✅ FIX 2: Group dine-in orders by tableId — one row per active table session
    const tableMap = new Map();
    const result = [];

    for (const order of orders) {
      if (order.tableId && ["confirmed", "preparing", "ready"].includes(order.status)) {
        const key = String(order.tableId);
        if (!tableMap.has(key)) {
          tableMap.set(key, order);
          result.push(order);
        }
        // Skip duplicate active orders for same table
      } else {
        result.push(order);
      }
    }

    const total = await Order.countDocuments(query);
    res.json({ orders: result, total, page: Number(page), limit: Number(limit) });
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

// DELETE /orders/table/:orderId/item — remove a specific item from an order
router.delete("/table/:orderId/item", requireAuth, async (req, res) => {
  try {
    const { roundIndex, itemIndex } = req.body;
    const order = await Order.findOne({ _id: req.params.orderId, businessId: req.businessId });
    if (!order) return res.status(404).json({ error: "Order not found" });

    if (order.rounds?.[roundIndex]?.items?.[itemIndex] !== undefined) {
      const removedItem = order.rounds[roundIndex].items[itemIndex];
      const removedTotal = removedItem.price * removedItem.quantity;
      order.rounds[roundIndex].items.splice(itemIndex, 1);
      order.total = Math.max(0, (order.total || 0) - removedTotal);

      // Remove round if empty
      if (order.rounds[roundIndex].items.length === 0) {
        order.rounds.splice(roundIndex, 1);
      }

      // Sync items array
      order.items = order.rounds.flatMap(r => r.items);

      // ✅ FIX 1: If no rounds left at all, auto-cancel the order
      if (order.rounds.length === 0) {
        order.status = "cancelled";
      }

      await order.save();
    }

    res.json({ order });
  } catch (err) {
    console.error("DELETE item error:", err);
    res.status(500).json({ error: "Failed to remove item" });
  }
});

// POST /orders/pickup — create a new manual order (pickup or delivery)
router.post("/pickup", requireAuth, async (req, res) => {
  try {
    const { customerName, customerPhone, orderType, items, scheduledTime, deliveryAddress } = req.body;
    if (!items?.length) return res.status(400).json({ error: "items are required" });

    const validTypes = ["pickup", "delivery", "dineIn"];
    const safeType = validTypes.includes(orderType) ? orderType : "pickup";

    const roundItems = items.map(i => ({
      name: i.name, quantity: i.quantity || 1,
      price: i.price || 0, extras: i.extras || [], notes: i.notes || null,
    }));
    const roundTotal = roundItems.reduce((sum, i) => sum + i.price * i.quantity, 0);

    const order = await Order.create({
      callId: `manual_${Date.now()}`,
      businessId: req.businessId,
      customerName: customerName || "Walk-in",
      customerPhone: customerPhone || null,
      orderType: safeType,
      deliveryAddress: deliveryAddress || null,
      scheduledTime: scheduledTime ? new Date(scheduledTime) : null,
      items: roundItems,
      rounds: [{ items: roundItems, sentAt: new Date() }],
      total: roundTotal,
      status: "confirmed",
    });

    res.status(201).json({ order });
  } catch (err) {
    console.error("POST /orders/pickup error:", err);
    res.status(500).json({ error: "Failed to create order" });
  }
});

// POST /orders/pickup/round — add a round to existing manual order
router.post("/pickup/round", requireAuth, async (req, res) => {
  try {
    const { orderId, items } = req.body;
    if (!orderId || !items?.length) return res.status(400).json({ error: "orderId and items are required" });

    const order = await Order.findOne({ _id: orderId, businessId: req.businessId });
    if (!order) return res.status(404).json({ error: "Order not found" });

    const roundItems = items.map(i => ({
      name: i.name, quantity: i.quantity || 1,
      price: i.price || 0, extras: i.extras || [], notes: i.notes || null,
    }));
    const roundTotal = roundItems.reduce((sum, i) => sum + i.price * i.quantity, 0);

    order.rounds.push({ items: roundItems, sentAt: new Date() });
    order.items.push(...roundItems);
    order.total = (order.total || 0) + roundTotal;
    await order.save();

    res.json({ order });
  } catch (err) {
    console.error("POST /orders/pickup/round error:", err);
    res.status(500).json({ error: "Failed to add round" });
  }
});

// PATCH /orders/:id/scheduled-time — update pickup/delivery time
router.patch("/:id/scheduled-time", requireAuth, async (req, res) => {
  try {
    const { scheduledTime } = req.body;
    const order = await Order.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!order) return res.status(404).json({ error: "Order not found" });
    order.scheduledTime = scheduledTime ? new Date(scheduledTime) : null;
    await order.save();
    res.json({ order });
  } catch (err) {
    res.status(500).json({ error: "Failed to update time" });
  }
});

// PATCH /orders/:id/complete — mark order as delivered/completed, removes from Manual Orders
router.patch("/:id/complete", requireAuth, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, businessId: req.businessId });
    if (!order) return res.status(404).json({ error: "Order not found" });
    order.status = order.orderType === "delivery" ? "delivered" : "ready";
    await order.save();
    res.json({ order });
  } catch (err) {
    res.status(500).json({ error: "Failed to complete order" });
  }
});

// GET /orders/manual/active — get all active manual (non-table) orders
router.get("/manual/active", requireAuth, async (req, res) => {
  try {
    const orders = await Order.find({
      businessId: req.businessId,
      tableId: null,
      status: { $in: ["confirmed", "preparing", "ready"] },
    })
      .sort({ createdAt: -1 })
      .lean();

    res.json({ orders });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch active manual orders" });
  }
});

module.exports = router;