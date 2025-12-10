// src/models/Agent.js
const mongoose = require("mongoose");

const AgentSchema = new mongoose.Schema(
  {
    // Link agent to its owner business (mandatory)
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },

    // Public identity of the AI agent
    name: { type: String, required: true, trim: true },

    // Classification of how it behaves
    businessType: {
      type: String,
      enum: ["restaurant", "clinic", "cafe", "salon", "hospital", "hotel"],
      required: true,
    },

    // Retell integration
    retellAgentId: { type: String },

    // Core AI config
    systemPrompt: { type: String, required: true },
    greetingMessage: { type: String },
    fallbackMessage: { type: String },
    closingMessage: { type: String },

    // Behavior / settings
    openingHours: { type: Object },
    languagePreference: {
      type: String,
      enum: ["ar", "en"],
      default: "ar", // Arabic first by default
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Agent", AgentSchema);