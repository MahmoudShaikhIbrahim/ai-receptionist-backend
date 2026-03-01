// src/models/Floor.js

const mongoose = require("mongoose");

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
      default: 1200,
      min: 300,
    },

    height: {
      type: Number,
      default: 800,
      min: 300,
    },

    /* ===========================
       Layout Background (GridFS)
    ============================ */
backgroundImageUrl: {
  type: String,
  default: null,
},
layoutImageUrl: {
  type: String,
  default: null,
},
    layoutImage: {
      type: {
        fileId: {
          type: mongoose.Schema.Types.ObjectId,
        },
        filename: String,
        contentType: String,
        uploadedAt: Date,
      },
      default: null,
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