// src/models/Business.js

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const BusinessSchema = new mongoose.Schema(
  {
    /* ======================
       CORE IDENTITY
    ====================== */
    businessName: {
      type: String,
      required: true,
      trim: true,
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      index: true,
      trim: true,
    },

    password: {
      type: String,
      required: true,
    },

    /* ======================
       CONTACT INFO
    ====================== */
    ownerPhoneNumber: {
      type: String,
      trim: true,
      default: null,
    },

    businessPhoneNumber: {
      type: String,
      trim: true,
      default: null,
    },

    /* ======================
       RESTAURANT SETTINGS
    ====================== */
    timezone: {
      type: String,
      required: true,
      default: "Asia/Dubai",
    },

    slotDurationMinutes: {
      type: Number,
      required: true,
      default: 15,
      min: 5,
      max: 60,
    },

    defaultDiningDurationMinutes: {
      type: Number,
      required: true,
      default: 90,
      min: 15,
      max: 300,
    },

    /* ======================
       LIVE FLOOR SETTINGS
    ====================== */
    liveUpcomingWindowMinutes: {
      type: Number,
      required: true,
      default: 30,
      min: 0,
      max: 180,
    },

    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true }
);

/* ======================
   PASSWORD HASHING
====================== */
BusinessSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

/* ======================
   PASSWORD CHECK
====================== */
BusinessSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

module.exports = mongoose.model("Business", BusinessSchema);