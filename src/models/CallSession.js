const mongoose = require("mongoose");

const CallSessionSchema = new mongoose.Schema(
  {
    callId: { type: String, required: true, unique: true, index: true },
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },

    callerNumber: { type: String, default: null },

    // Slots
    partySize: { type: Number, default: null },
    name: { type: String, default: null },
    requestedStartIso: { type: Date, default: null },

    // Flow control
    step: {
      type: String,
      enum: ["ASK_GUESTS", "ASK_TIME", "ASK_NAME", "CONFIRM", "DONE"],
      default: "ASK_GUESTS",
    },

    lastAssistantText: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CallSession", CallSessionSchema);