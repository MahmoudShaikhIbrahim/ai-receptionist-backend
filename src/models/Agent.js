// src/models/Agent.js
const mongoose = require("mongoose");

const ExtraSchema = new mongoose.Schema(
  { name: String, price: Number },
  { _id: false }
);

const MenuItemSchema = new mongoose.Schema(
  {
    category: { type: String, default: "General" },
    name: { type: String, required: true },
    description: { type: String, default: "" },
    price: { type: Number, required: true },
    currency: { type: String, default: "AED" },
    available: { type: Boolean, default: true },
    extras: [ExtraSchema],
  },
  { timestamps: true }
);

const OpeningHoursSchema = new mongoose.Schema(
  {
    open: String,
    close: String,
    closed: { type: Boolean, default: false },
  },
  { _id: false }
);

const AgentSchema = new mongoose.Schema(
  {
    /* ======================
       OWNERSHIP
    ====================== */
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
    },
    businessName: { type: String, required: true },
    ownerEmail: { type: String, required: true },
    businessPhoneNumber: { type: String },
    businessType: { type: String, default: "restaurant" },

    /* ======================
       RETELL (ADMIN ONLY)
    ====================== */
    retellAgentId: { type: String, immutable: true },
    retellAgentName: { type: String },

    /* ======================
       AGENT PERSONALITY
    ====================== */
    agentName: { type: String, default: "AI Receptionist" },
    agentPrompt: { type: String, default: "" },
    language: { type: String, default: "English" },

    /* ======================
       FEATURES
    ====================== */
    features: {
      bookings: { type: Boolean, default: true },
      orders: { type: Boolean, default: false },
      delivery: { type: Boolean, default: false },
      pickup: { type: Boolean, default: false },
      dineIn: { type: Boolean, default: true },
    },

    /* ======================
       OPENING HOURS
    ====================== */
    openingHours: {
      monday:    { type: OpeningHoursSchema, default: {} },
      tuesday:   { type: OpeningHoursSchema, default: {} },
      wednesday: { type: OpeningHoursSchema, default: {} },
      thursday:  { type: OpeningHoursSchema, default: {} },
      friday:    { type: OpeningHoursSchema, default: {} },
      saturday:  { type: OpeningHoursSchema, default: {} },
      sunday:    { type: OpeningHoursSchema, default: {} },
    },

    /* ======================
       MENU
    ====================== */
    menu: [MenuItemSchema],

    /* ======================
       CHANGE REQUEST (keep existing)
    ====================== */
    changeRequestText: { type: String },
    changeRequestStatus: {
      type: String,
      enum: ["none", "pending", "applied"],
      default: "none",
    },
    changeRequestUpdatedAt: { type: Date },
    changeRequestAppliedAt: { type: Date },
  },
  { timestamps: true }
);

AgentSchema.index({ retellAgentId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("Agent", AgentSchema);