// src/controllers/llmSocketController.js

const Business = require("../models/Business");
const Agent = require("../models/Agent");
const CallSession = require("../models/CallSession");
const { nowInTZ } = require("../utils/time");
const { findNearestAvailableSlot } = require("../services/bookingService");
const { DateTime } = require("luxon");



async function processLLMMessage(body) {
  console.log("WS BODY:", body);

  const interactionType = body.interaction_type;

  if (interactionType === "call_started") {
    return "Welcome to our restaurant. How many people?";
  }

  if (interactionType === "response_required") {
    return "How many people would you like to book for?";
  }

  return "";
}

module.exports = { processLLMMessage };