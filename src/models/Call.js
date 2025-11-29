const mongoose = require("mongoose");

const CallSchema = new mongoose.Schema(
  {
    call_id: String,
    agent_name: String,
    call_type: String,
    call_status: String
  },
  { timestamps: true }
);

module.exports = mongoose.model("Call", CallSchema);