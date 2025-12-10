// src/models/Business.js
const mongoose = require("mongoose");

const BusinessSchema = new mongoose.Schema(
  {
    businessName: { type: String, required: true, trim: true },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    passwordHash: {
      type: String,
      required: true,
    },

    businessType: {
      type: String,
      enum: ["restaurant", "clinic", "cafe", "salon", "hospital", "hotel"],
      required: true,
    },

    ownerName: { type: String, trim: true },
    businessPhone: { type: String, trim: true },

    timezone: {
      type: String,
      default: "Asia/Dubai",
    },

    languagePreference: {
      type: String,
      enum: ["ar", "en"],
      default: "ar", // Arabic-first by default
    },

    // One business = one main AI agent (for now)
    agentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Agent",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Business", BusinessSchema);