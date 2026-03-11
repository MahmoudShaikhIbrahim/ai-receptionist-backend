const Agent = require("../models/Agent");
const Call = require("../models/Call");
const Booking = require("../models/Booking");

const { wordsToNumbers } = require("words-to-numbers");
const { getAIResponse } = require("../services/aiChatService");
const { findNearestAvailableSlot } = require("../services/bookingService");

function normalizeText(value) {
  if (typeof value !== "string") return "";
  return wordsToNumbers(value.toLowerCase()).trim();
}

function isConversationEnding(text) {
  if (!text) return false;

  const phrases = [
    "bye",
    "goodbye",
    "thank you bye",
    "thanks bye",
    "that's all",
    "nothing else",
    "thank you",
  ];

  const lower = text.toLowerCase();
  return phrases.some((p) => lower.includes(p));
}

function extractBookingDataFromTranscript(transcript) {
  let partySize = null;
  let requestedStart = null;
  let customerName = null;

  for (const item of transcript) {
    if (!item?.content) continue;

    const normalized = normalizeText(item.content);

    if (!partySize) {
      const match = normalized.match(/\b(\d+)\b/);
      if (match) partySize = parseInt(match[1]);
    }

    if (!requestedStart) {
      const match = normalized.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);

      if (match) {
        let hour = parseInt(match[1]);
        const minute = parseInt(match[2] || "0");

        if (match[3] === "pm" && hour < 12) hour += 12;
        if (match[3] === "am" && hour === 12) hour = 0;

        const date = new Date();
        date.setHours(hour, minute, 0, 0);
        requestedStart = date;
      }
    }

    if (!customerName) {
      const nameMatch = item.content.match(/my name is (.+)/i);
      if (nameMatch) customerName = nameMatch[1];
    }
  }

  return {
    partySize,
    requestedStart,
    customerName: customerName || "Phone Guest",
  };
}

async function processLLMMessage(body) {
  const transcript = Array.isArray(body.transcript)
    ? body.transcript
    : Array.isArray(body.transcript_json)
    ? body.transcript_json
    : [];

  const callId = body.call_id;
  const latestUserText = body.latest_user_text || "";

  if (isConversationEnding(latestUserText)) {
    return {
      response: "Thank you for calling. Have a great day!",
      endCall: true,
    };
  }

  const { partySize, requestedStart, customerName } =
    extractBookingDataFromTranscript(transcript);

  try {
    if (partySize && requestedStart && callId) {
      const existingBooking = await Booking.findOne({
        callId,
        status: { $in: ["confirmed", "seated"] },
      }).lean();

      if (existingBooking) {
        return { response: "Your reservation is already confirmed." };
      }

      const call = await Call.findOne({
        $or: [{ callId }, { call_id: callId }],
      }).lean();

      if (call) {
        const agent = await Agent.findById(call.agentId).lean();

        if (agent) {
          const result = await findNearestAvailableSlot({
            businessId: agent.businessId,
            requestedStart,
            durationMinutes: 90,
            partySize,
            source: "ai",
            agentId: agent._id,
            callId,
            customerName,
            customerPhone: null,
            notes: null,
            searchWindowMinutes: 120,
          });

          if (result?.success) {
            return { response: "Perfect. Your table is confirmed." };
          }

          if (result?.suggestedTime) {
            const t = new Date(result.suggestedTime);

            const label = t.toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
              hour12: true,
            });

            return {
              response: `We are full at that time. Would ${label} work instead?`,
            };
          }
        }
      }
    }

    const messages = [
      {
        role: "system",
        content:
          "You are a friendly restaurant receptionist helping customers.",
      },
      ...transcript.map((m) => ({
        role: m.role === "agent" ? "assistant" : "user",
        content: m.content,
      })),
    ];

    const aiReply = await getAIResponse(messages);

    return {
      response: aiReply || "Could you repeat that please?",
    };
  } catch (err) {
    console.error("Controller error:", err);
    return { response: "Sorry, could you repeat that please?" };
  }
}

module.exports = { processLLMMessage };