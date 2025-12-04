const mongoose = require("mongoose");

const CallSchema = new mongoose.Schema(
  {
    from: { type: String, required: true },
    to: { type: String, required: true },
    timestamp: { type: Date, required: true },
    duration: { type: Number },
    transcript: { type: String },
    outcome: { type: String }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Call", CallSchema);