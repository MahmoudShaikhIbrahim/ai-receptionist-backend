// src/models/Table.js
const mongoose = require("mongoose");

const TableSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },

    floorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Floor",
      required: true,
      index: true,
    },

    label: {
      type: String,
      required: true,
      trim: true,
      maxLength: 20,
    },

    capacity: {
      type: Number,
      required: true,
      min: 1,
      max: 50,
    },

    // 2D Layout positioning
    x: {
      type: Number,
      default: 0,
      min: 0,
    },

    y: {
      type: Number,
      default: 0,
      min: 0,
    },

    w: {
      type: Number,
      default: 80,
      min: 20,
    },

    h: {
      type: Number,
      default: 80,
      min: 20,
    },

    rotation: {
      type: Number,
      default: 0,
      min: 0,
      max: 360,
    },

    zone: {
      type: String,
      trim: true,
      default: null,
    },

    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    /* ======================
       MAINTENANCE FLAG
    ====================== */
    isMaintenance: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  { timestamps: true }
);

// Unique table label per business
TableSchema.index(
  { businessId: 1, label: 1 },
  { unique: true }
);

// Optimized filtering
TableSchema.index(
  { businessId: 1, floorId: 1, isActive: 1 }
);

TableSchema.index(
  { businessId: 1, capacity: 1, isActive: 1 }
);

module.exports = mongoose.model("Table", TableSchema);