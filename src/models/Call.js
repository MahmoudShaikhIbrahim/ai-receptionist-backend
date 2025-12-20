const mongoose = require("mongoose");

const CallSchema = new mongoose.Schema(
  {
    // External identifiers (source of truth)
    call_id: { type: String, required: true, index: true },
    provider: { type: String, default: "retell" },

    // Retell agent info (string-based)
    agent_id: { type: String },      // retell agent id
    agent_name: { type: String },

    // Call data
    from: String,
    to: String,
    call_type: String,
    outcome: String,
    duration: Number,
    transcript: String,
    timestamp: Date,

    // Internal linking (optional, async)
    agentRef: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Agent",
      default: null,
    },
    businessRef: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      default: null,
    },

    // Full raw payload (critical for future-proofing)
    raw: { type: Object, required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Call", CallSchema);