// src/models/Order.js

const mongoose = require("mongoose");

const OrderItemSchema = new mongoose.Schema(
  {
    name: String,
    quantity: { type: Number, default: 1 },
    price: Number,
    extras: [String],
    notes: { type: String, default: null },
  },
  { _id: false }
);

const RoundSchema = new mongoose.Schema(
  {
    items: [OrderItemSchema],
    sentAt: { type: Date, default: Date.now },
    notes: { type: String, default: null },
  },
  { _id: true }
);

const OrderSchema = new mongoose.Schema(
  {
    callId: { type: String, default: null },
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business" },
    agentId: { type: mongoose.Schema.Types.ObjectId, ref: "Agent" },
    customerName: String,
    customerPhone: String,
    deliveryAddress: { type: String, default: null },
    scheduledTime: { type: Date, default: null },
    tableId: { type: mongoose.Schema.Types.ObjectId, ref: "Table", default: null },
    tableLabel: { type: String, default: null },
    items: [OrderItemSchema],
    rounds: [RoundSchema],
    orderType: {
      type: String,
      enum: ["dineIn", "pickup", "delivery"],
      default: "dineIn",
    },
    total: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["pending", "confirmed", "preparing", "ready", "delivered", "cancelled"],
      default: "confirmed",
    },
    notes: String,
  },
  { timestamps: true }
);

module.exports = mongoose.model("Order", OrderSchema);