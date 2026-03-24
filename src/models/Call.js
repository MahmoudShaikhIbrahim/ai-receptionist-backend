// src/models/Call.js

const mongoose = require("mongoose");

const CallSchema = new mongoose.Schema(
  {
    // 🔑 Multi-tenant routing (REQUIRED)
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },

    agentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Agent",
      required: true,
      index: true,
    },

    // 🔑 Retell identifiers
    retellAgentId: {
      type: String,
      required: true,
      index: true,
    },

    callId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    // ☎️ Phone metadata
    callerNumber: {
      type: String,
      default: null,
    },

    calleeNumber: {
      type: String,
      default: null,
    },

    // 🧠 Classification (optional, future-proof)
    intent: {
      type: String,
      enum: ["order", "booking", "inquiry", "unknown"],
      default: "unknown",
    },

    // 📦 Structured outcomes (filled later)
    orderData: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    // ✅ Single unified booking draft (replaces bookingData + reservationDraft)
    bookingDraft: {
      partySize: { type: Number, default: null },
      requestedStart: { type: Date, default: null },
      customerName: { type: String, default: null },
      customerPhone: { type: String, default: null },
    },

    orderDraft: {
  items: { type: Array, default: [] },
  orderType: { type: String, default: null },
  status: { type: String, default: null },
  deliveryAddress: { type: String, default: null },
},

    // 📝 AI outputs
    summary: {
      type: String,
      default: null,
    },

    transcript: {
      type: String,
      default: null,
    },

    // ⏱️ Timing
    startedAt: {
      type: Date,
      default: null,
    },

    endedAt: {
      type: Date,
      default: null,
    },

    durationSeconds: {
      type: Number,
      default: null,
    },
  },
  {
    timestamps: true,
    strict: true,
  }
);

module.exports = mongoose.model("Call", CallSchema);