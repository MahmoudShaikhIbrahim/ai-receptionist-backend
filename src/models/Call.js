const mongoose = require("mongoose");

const CallSchema = new mongoose.Schema(
  {
    // Routing (PRIMARY)
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

    retellAgentId: {
      type: String,
      required: true,
      index: true,
    },

    // Retell identifiers
    callId: {
      type: String,
      required: true,
      unique: true,
    },

    // Call metadata
    callerNumber: { type: String },
    calleeNumber: { type: String },

    // Classification
    intent: {
      type: String,
      enum: ["order", "booking", "inquiry", "unknown"],
      default: "unknown",
    },

    // Structured outcomes
    orderData: { type: Object, default: null },
    bookingData: { type: Object, default: null },

    // AI output
    summary: { type: String },
    transcript: { type: String },

    startedAt: { type: Date },
    endedAt: { type: Date },
    durationSeconds: { type: Number },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Call", CallSchema);