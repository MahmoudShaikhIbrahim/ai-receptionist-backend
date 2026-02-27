// src/models/Agent.js
const mongoose = require("mongoose");

const OpeningHoursSchema = new mongoose.Schema(
  {
    day: String,
    open: String,
    close: String,
    closed: Boolean,
  },
  { _id: false }
);

const AgentSchema = new mongoose.Schema(
  {
    /* ======================
       OWNERSHIP
    ====================== */
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
    },

    businessName: { type: String, required: true },
    ownerEmail: { type: String, required: true },
    businessPhoneNumber: { type: String },

    businessType: {
      type: String,
      default: "restaurant", // restaurant / cafe / clinic / etc.
    },

    /* ======================
       RETELL (ADMIN ONLY)
       Immutable mapping
    ====================== */
    retellAgentId: {
      type: String,
      immutable: true, // 🔒 never editable by business
    },

    retellAgentName: {
      type: String, // optional helper for admin search
    },

    /* ======================
       BUSINESS REQUEST
       (Free text, any language)
    ====================== */
    changeRequestText: {
      type: String,
    },

    changeRequestStatus: {
      type: String,
      enum: ["none", "pending", "applied"],
      default: "none",
    },

    changeRequestUpdatedAt: {
      type: Date,
    },

    changeRequestAppliedAt: {
      type: Date,
    },

    /* ======================
       BUSINESS LOGIC
    ====================== */
    openingHours: {
      type: Object,
      default: {},
    },
  },
  { timestamps: true }
);
// Ensure one-to-one mapping between Retell agent and business
AgentSchema.index(
  { retellAgentId: 1 },
  { unique: true, sparse: true }
);

module.exports = mongoose.model("Agent", AgentSchema);