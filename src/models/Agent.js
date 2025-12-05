// src/models/Agent.js

const mongoose = require("mongoose");

const AgentSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    businessName: { type: String, required: true, trim: true },

    ownerEmail: { type: String },
    businessPhoneNumber: { type: String },

    industry: { type: String },
    timezone: { type: String },
    language: { type: String },

    retellAgentId: { type: String },
    systemPrompt: { type: String, required: true },
    greetingMessage: { type: String },
    fallbackMessage: { type: String },
    closingMessage: { type: String },
    openingHours: { type: Object }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Agent", AgentSchema);