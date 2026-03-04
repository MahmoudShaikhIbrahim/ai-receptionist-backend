// src/controllers/llmSocketController.js

const Business = require("../models/Business");
const Agent = require("../models/Agent");
const CallSession = require("../models/CallSession");
const { nowInTZ } = require("../utils/time");
const { findNearestAvailableSlot } = require("../services/bookingService");
const { DateTime } = require("luxon");
const { getAIResponse } = require("../services/aiChatService");

async function processLLMMessage(body) {
  console.log("Processing WS body:", body);

  const type = body.type || body.interaction_type || "unknown";

  // Ignore streaming updates
  if (type === "update_only" || type === "ping_pong") {
    return "";
  }

  // Only respond when Retell explicitly asks
  if (!["response_required", "reminder_required"].includes(type)) {
    console.log("Ignoring event:", type);
    return "";
  }

  const transcript = Array.isArray(body.transcript) ? body.transcript : [];

  // Convert Retell transcript → OpenAI messages
  const messages = [
    {
      role: "system",
      content: `
You are a friendly restaurant receptionist.

You speak naturally like a human.
You can respond to greetings, small talk, or questions.

Your main goal is to help customers make reservations.

When a user wants to book a table, collect:
- number of people
- time
- optionally their name

Ask only ONE question at a time.
Never repeat the same question if the user already answered it.
Keep responses short because this is a voice conversation.
`
    }
  ];

  for (const item of transcript) {
    if (!item || typeof item.content !== "string") continue;

    if (item.role === "user") {
      messages.push({
        role: "user",
        content: item.content.trim()
      });
    }

    if (item.role === "agent") {
      messages.push({
        role: "assistant",
        content: item.content.trim()
      });
    }
  }

  try {
    const aiReply = await getAIResponse(messages);

    console.log("AI reply:", aiReply);

    return aiReply;

  } catch (err) {
    console.error("AI error:", err.message);

    return "Sorry, I didn't catch that. Could you repeat that please?";
  }
}

module.exports = { processLLMMessage };