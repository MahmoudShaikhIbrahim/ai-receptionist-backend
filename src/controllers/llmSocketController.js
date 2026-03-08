const Business = require("../models/Business");
const Agent = require("../models/Agent");
const CallSession = require("../models/CallSession");

const { nowInTZ } = require("../utils/time");
const { DateTime } = require("luxon");

const { getAIResponse } = require("../services/aiChatService");
const { createAIBooking } = require("./bookingEngineController");

async function processLLMMessage(body) {

  console.log("Processing WS body:", JSON.stringify(body));

  const interactionType = body.interaction_type || body.type || "unknown";

  if (interactionType === "ping_pong") return null;

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

  const messages = [
    {
      role: "system",
      content: `
You are a friendly restaurant receptionist.

Your job is to help customers reserve tables.

Collect:
- number of people
- time
- name

Ask only ONE question at a time.
Keep responses short.
`
    }
  ];

  for (const item of transcript) {
    if (!item || typeof item.content !== "string") continue;

    if (item.role === "user" || item.role === "caller") {
      messages.push({ role: "user", content: item.content.trim() });
    }

    if (item.role === "assistant" || item.role === "agent") {
      messages.push({ role: "assistant", content: item.content.trim() });
    }
  }

  try {

    const aiReply = await getAIResponse(messages);

    const lastUser = transcript
      .filter(t => t.role === "user" || t.role === "caller")
      .pop();

    if (!lastUser) {
      return { response: aiReply };
    }

    const text = lastUser.content.toLowerCase();

    const partyMatch = text.match(/\b(\d+)\b/);
    const timeMatch = text.match(/\b(\d{1,2})(?::(\d{2}))?\s?(am|pm)?\b/i);

    if (partyMatch && timeMatch) {

      console.log("📅 Booking intent detected");

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

      const retellAgentId = body.agent_id;
      const callId = body.call_id;

      try {

        const result = await createAIBooking({
          body: {
            partySize,
            startTime: requestedStart,
            customerName: "Phone Guest",
            callId,
            retellAgentId
          }
        }, {
          json: (data) => data,
          status: () => ({ json: (data) => data })
        });

        console.log("AI booking engine result:", result);

        if (result?.success) {
          return { response: "Perfect. Your table is confirmed." };
        }

        if (result?.suggestedTime) {
          return {
            response: `We are full at that time. Would ${result.suggestedTime} work instead?`
          };
        }

      } catch (bookingError) {
        console.error("Booking engine error:", bookingError);
      }

    }

    return { response: aiReply };

  } catch (err) {

    console.error("AI error:", err);

    return {
      response: "Sorry, could you repeat that please?"
    };

  }

}

module.exports = { processLLMMessage };