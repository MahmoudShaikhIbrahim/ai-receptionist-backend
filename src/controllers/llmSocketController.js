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
    Array.isArray(body.transcript)
      ? body.transcript
      : Array.isArray(body.transcript_json)
      ? body.transcript_json
      : [];

  console.log("Transcript length:", transcript.length);

  const messages = [
    {
      role: "system",
      content: `
You are a friendly restaurant receptionist.

Speak naturally like a human.

You can respond to greetings and small talk.

Your main goal is to help customers make reservations.

When a customer wants to book a table collect:
- number of people
- time
- optionally name

Ask only ONE question at a time.

Do NOT repeat the same question if it was already answered.

Keep responses short because this is a voice conversation.
`
    }
  ];

  // Convert Retell transcript → OpenAI messages
  for (const item of transcript) {
    if (!item || typeof item.content !== "string") continue;

    const role = item.role;

    // User speech
    if (role === "user" || role === "caller") {
      messages.push({
        role: "user",
        content: item.content.trim()
      });
    }

    // Assistant speech
    if (role === "assistant" || role === "agent") {
      messages.push({
        role: "assistant",
        content: item.content.trim()
      });
    }
  }

  console.log("Messages sent to AI:", messages);

  // Detect if user has spoken
  const lastUser = transcript.find(
    (t) => t.role === "user" || t.role === "caller"
  );

  if (!lastUser) {
    console.log("No user speech detected yet");
    return "Hello! Welcome to our restaurant. How can I help you today?";
  }

  try {
    const aiReply = await getAIResponse(messages);

    console.log("AI reply:", aiReply);

    if (!aiReply || aiReply.trim() === "") {
      return "Could you please repeat that?";
    }

    return aiReply;
  } catch (err) {
    console.error("AI error:", err.message);

    return "Sorry, could you repeat that please?";
  }
}

module.exports = { processLLMMessage };