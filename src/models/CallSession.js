const mongoose = require("mongoose");

const CallSessionSchema = new mongoose.Schema(
  {
    callId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },

    callerNumber: {
      type: String,
      default: null,
    },

    /* ===============================
       Booking Slots
    =============================== */

    partySize: {
      type: Number,
      default: null,
    },

    name: {
      type: String,
      default: null,
      trim: true,
      maxlength: 50,
    },

    requestedStartIso: {
      type: Date,
      default: null,
    },

    /* ===============================
       Conversation State
    =============================== */

    step: {
      type: String,
      enum: ["ASK_GUESTS", "ASK_TIME", "ASK_NAME", "CONFIRM", "DONE"],
      default: "ASK_GUESTS",
      index: true,
    },

    /**
     * Conversation language memory
     * ar = Arabic
     * en = English
     * null = auto-detect first message
     */
    lang: {
      type: String,
      enum: ["ar", "en"],
      default: null,
      index: true,
    },

    lastAssistantText: {
      type: String,
      default: null,
    },
    hasStarted: { type: Boolean, default: false }
  },
  { timestamps: true }
);

/* ===============================
   Safety Index
=============================== */

CallSessionSchema.index({ businessId: 1, step: 1 });

module.exports = mongoose.model("CallSession", CallSessionSchema);