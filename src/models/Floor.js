// src/models/Floor.js

const mongoose = require("mongoose");
const { maxLength } = require("zod");

const floorSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
      maxLength: 50,
    },

    width: {
      type: Number,
      default: 1200, // grid canvas width
      min: 300,
    },

    height: {
      type: Number,
      default: 800, // grid canvas height
      min: 300,
    },

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// Prevent duplicate floor names per business
floorSchema.index({ businessId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("Floor", floorSchema);