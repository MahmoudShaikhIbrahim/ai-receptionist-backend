// src/controllers/llmSocketController.js

const Business = require("../models/Business");
const Agent = require("../models/Agent");
const CallSession = require("../models/CallSession");
const { nowInTZ } = require("../utils/time");
const { findNearestAvailableSlot } = require("../services/bookingService");
const { DateTime } = require("luxon");


const { getAIResponse } = require("../services/aiChatService");

async function processLLMMessage(body) {
  console.log("Processing WS body:", JSON.stringify(body));

  const interactionType = body.interaction_type || body.type || "unknown";

  // Ignore ping events
  if (interactionType === "ping_pong") {
    return "";
  }

  // Extract transcript safely
  const transcript =
    Array.isArray(body.transcript) ? body.transcript :
    Array.isArray(body.transcript_json) ? body.transcript_json :
    [];

  const messages = [
    {
      role: "system",
      content: `
You are a friendly restaurant receptionist.

Speak naturally like a human.

You can respond to greetings and small talk.

Your goal is to help customers book tables.

When a customer wants a reservation collect:
- number of people
- time
- optionally name

Ask only ONE question at a time.

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

  // If user hasn't spoken yet
  const lastUser = transcript.find(t => t.role === "user");

  if (!lastUser) {
    return "Hello! Welcome to our restaurant. How can I help you today?";
  }

  try {
    const aiReply = await getAIResponse(messages);

    console.log("AI reply:", aiReply);

    return aiReply || "Could you repeat that please?";
  } catch (err) {
    console.error("AI error:", err.message);

    return "Sorry, could you repeat that please?";
  }
}

module.exports = { processLLMMessage };