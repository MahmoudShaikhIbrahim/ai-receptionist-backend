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
    return null;
  }

  // IMPORTANT: only respond when Retell asks for a response
  if (interactionType !== "response_required") {
    console.log("Skipping event:", interactionType);
    return null;
  }

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

Your job is to help customers book tables.

Collect:
- number of people
- time
- name

Ask only ONE question at a time.

Do not repeat questions already answered.

Keep responses short.
`
    }
  ];

  for (const item of transcript) {
    if (!item || typeof item.content !== "string") continue;

    if (item.role === "user" || item.role === "caller") {
      messages.push({
        role: "user",
        content: item.content.trim()
      });
    }

    if (item.role === "assistant" || item.role === "agent") {
      messages.push({
        role: "assistant",
        content: item.content.trim()
      });
    }
  }

  console.log("Messages sent to AI:", messages);

  try {

    const aiReply = await getAIResponse(messages);

    console.log("AI reply:", aiReply);

    /* =====================================================
       SIMPLE BOOKING EXTRACTION
       (temporary logic until structured output)
    ===================================================== */

    const lastUser = transcript
      .filter(t => t.role === "user" || t.role === "caller")
      .pop();

    if (lastUser && typeof lastUser.content === "string") {

      const text = lastUser.content.toLowerCase();

      const partyMatch = text.match(/\b(\d+)\b/);
      const timeMatch = text.match(/\b(\d{1,2})(?::(\d{2}))?\s?(am|pm)?\b/i);

      if (partyMatch && timeMatch) {

        console.log("Booking intent detected");

        const partySize = parseInt(partyMatch[1], 10);

        let hour = parseInt(timeMatch[1], 10);
        const minute = parseInt(timeMatch[2] || "0", 10);

        if (timeMatch[3]?.toLowerCase() === "pm" && hour < 12) {
          hour += 12;
        }

        const requestedStart = new Date();
        requestedStart.setHours(hour);
        requestedStart.setMinutes(minute);
        requestedStart.setSeconds(0);
        requestedStart.setMilliseconds(0);

        try {

          const retellAgentId = body.agent_id;
const callId = body.call_id;

const agent = await Agent.findOne({ retellAgentId });

if (!agent) {
  console.warn("Agent not found for retellAgentId:", retellAgentId);
  return { response: aiReply };
}

const bookingResult = await findNearestAvailableSlot({
  businessId: agent.businessId,
  requestedStart,
  partySize,
  source: "phone_ai",
  agentId: agent._id,
  callId,
  customerName: "Phone Guest"
});

          console.log("Booking result:", bookingResult);

        } catch (bookingError) {
          console.error("Booking engine error:", bookingError.message);
        }

      }

    }

    if (typeof aiReply !== "string" || aiReply.trim() === "") {
      return {
        response: "Could you repeat that please?"
      };
    }

    return {
      response: aiReply
    };

  } catch (err) {

    console.error("AI error:", err.message);

    return {
      response: "Sorry, could you repeat that please?"
    };

  }
}

module.exports = { processLLMMessage };