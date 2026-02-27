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

    bookingData: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
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
    strict: true, // ⛔ prevents silent garbage fields
  }
);

module.exports = mongoose.model("Call", CallSchema);