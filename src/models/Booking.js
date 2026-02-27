// src/models/Booking.js
const mongoose = require("mongoose");

const BookingSchema = new mongoose.Schema(
  {
    /* =====================================================
       RELATIONSHIP
    ===================================================== */
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },

    /**
     * Support multiple tables (for table combination).
     * Even if single table is used, it will be an array of one.
     */
    tables: [
      {
        tableId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Table",
          required: true,
        },
        capacity: {
          type: Number,
          required: true,
        },
        _id: false,
      },
    ],

    /* =====================================================
       OPTIONAL AI / CALL LINKAGE
    ===================================================== */
    agentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Agent",
      default: null,
      index: true,
    },

    callId: {
      type: String,
      default: null,
      index: true,
    },

    /* =====================================================
       TIME WINDOW
    ===================================================== */
    startIso: {
      type: Date,
      required: true,
      index: true,
    },

    endIso: {
      type: Date,
      required: true,
      index: true,
    },

    /* =====================================================
       RESERVATION DETAILS
    ===================================================== */
    partySize: {
      type: Number,
      required: true,
      min: 1,
      max: 50,
    },

    customerName: {
      type: String,
      trim: true,
      default: null,
    },

    customerPhone: {
      type: String,
      trim: true,
      default: null,
    },

    notes: {
      type: String,
      trim: true,
      default: null,
    },

    source: {
      type: String,
      enum: ["ai", "dashboard", "manual"],
      required: true,
      index: true,
    },

    /**
     * Full lifecycle support for hybrid system
     */
    status: {
      type: String,
      enum: [
        "confirmed",  // future reservation
        "seated",     // guest arrived
        "completed",  // finished dining
        "cancelled",  // cancelled before arrival
        "no_show",    // never arrived
      ],
      default: "confirmed",
      index: true,
    },
  },
  { timestamps: true }
);

/* =====================================================
   INDEXES
   (Query optimization only — NOT conflict prevention)
===================================================== */

// Business time range queries
BookingSchema.index({
  businessId: 1,
  startIso: 1,
  endIso: 1,
  status: 1,
});

// Business + table overlap queries
BookingSchema.index({
  businessId: 1,
  "tables.tableId": 1,
  startIso: 1,
  endIso: 1,
  status: 1,
});

module.exports = mongoose.model("Booking", BookingSchema);