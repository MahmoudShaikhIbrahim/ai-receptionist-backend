// src/models/Order.js

const mongoose = require("mongoose");

const OrderItemSchema = new mongoose.Schema(
  {
    name: String,
    quantity: { type: Number, default: 1 },
    price: Number,
    extras: [String],
  },
  { _id: false }
);

const OrderSchema = new mongoose.Schema(
  {
    callId: { type: String, required: true },
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business" },
    agentId: { type: mongoose.Schema.Types.ObjectId, ref: "Agent" },
    customerName: String,
    customerPhone: String,
    deliveryAddress: { type: String, default: null },
    items: [OrderItemSchema],
    orderType: {
      type: String,
      enum: ["dineIn", "pickup", "delivery"],
      default: "dineIn",
    },
    total: Number,
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