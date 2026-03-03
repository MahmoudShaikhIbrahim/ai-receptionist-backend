// src/controllers/llmSocketController.js

const Business = require("../models/Business");
const Agent = require("../models/Agent");
const CallSession = require("../models/CallSession");
const { nowInTZ } = require("../utils/time");
const { findNearestAvailableSlot } = require("../services/bookingService");
const { DateTime } = require("luxon");



async function processLLMMessage(body) {
  console.log("Processing WS body:", body);

  const type = body.type || body.interaction_type || "unknown";

  if (type === "call_started" || type === "start" || type === "metadata") {
    // Optional: log call info, save to DB
    return "Welcome to our restaurant. How many people would you like to book for?";
  }

  if (type === "update") {
    const transcript = body.transcript || body.content || "";
    const isFinal = body.is_final || body.final || false;

    if (!isFinal) {
      // Optional: handle partial transcript if you want real-time thinking
      return ""; // don't respond until final
    }

    // Simple logic example – improve with real LLM call later
    const lower = transcript.toLowerCase();

    if (lower.includes("book") || lower.includes("table") || lower.includes("reservation")) {
      return "Great! How many people would you like to book for?";
    }

    if (lower.match(/\d+/)) {  // contains number
      return "Perfect, for how many people? And what time would you prefer?";
    }

    return "Sorry, could you please clarify? Are you looking to make a reservation?";
  }

  if (type === "response_required") {  // if Retell ever sends this
    return "How many people would you like to book for?";
  }

  console.log("Unhandled type:", type);
  return "";
}

module.exports = { processLLMMessage };