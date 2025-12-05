// src/models/Call.js

const mongoose = require("mongoose");

const CallSchema = new mongoose.Schema(
  {
    // Which agent handled this call
    agent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Agent",
      required: false, // keep optional for old data
    },

    from: { type: String, required: true }, // caller
    to: { type: String, required: true },   // number they called

    timestamp: { type: Date, required: true },

    duration: { type: Number }, // in seconds (optional)
    transcript: { type: String },
    outcome: { type: String }, // e.g., "completed", "missed", "voicemail"

    // Later we can add: tags, sentiment, recordingUrl, etc.
  },
  { timestamps: true }
);

module.exports = mongoose.model("Call", CallSchema);