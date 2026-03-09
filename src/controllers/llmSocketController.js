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

function extractPartySizeFromText(text) {
  if (!text) return null;

  const match = text.match(/\b(\d+)\s*(people|persons|guests|guest|person|pax)?\b/i);
  if (!match) return null;

  const partySize = parseInt(match[1], 10);
  if (!Number.isInteger(partySize) || partySize <= 0) return null;

  return partySize;
}

function extractTimeFromText(text) {
  if (!text) return null;

  const match = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!match) return null;

  let hour = parseInt(match[1], 10);
  const minute = parseInt(match[2] || "0", 10);
  const meridiem = match[3] ? match[3].toLowerCase() : null;

  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (minute < 0 || minute > 59) return null;

  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;

  if (hour < 0 || hour > 23) return null;

  const requestedStart = new Date();
  requestedStart.setHours(hour, minute, 0, 0);

  return requestedStart;
}

function extractNameFromText(text) {
  if (!text) return null;

  const patterns = [
    /\bmy name is\s+([a-z][a-z\s'-]{1,49})\b/i,
    /\bthis is\s+([a-z][a-z\s'-]{1,49})\b/i,
    /\bit'?s\s+([a-z][a-z\s'-]{1,49})\b/i,
    /\bi am\s+([a-z][a-z\s'-]{1,49})\b/i,
    /\bi'm\s+([a-z][a-z\s'-]{1,49})\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const cleaned = match[1]
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\b(at|for|on|around|with)\b.*$/i, "")
        .trim();

      if (cleaned.length >= 2) {
        return cleaned
          .split(" ")
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
          .join(" ");
      }
    }
  }

  return null;
}

function extractBookingDataFromTranscript(transcript) {
  let partySize = null;
  let requestedStart = null;
  let customerName = null;

  const callerUtterances = transcript.filter(
    (item) =>
      item &&
      typeof item.content === "string" &&
      (item.role === "user" || item.role === "caller")
  );

  for (const utterance of callerUtterances) {
    const normalized = normalizeText(utterance.content);

    if (!partySize) {
      partySize = extractPartySizeFromText(normalized);
    }

    if (!requestedStart) {
      requestedStart = extractTimeFromText(normalized);
    }

    if (!customerName) {
      customerName = extractNameFromText(utterance.content);
    }
  }

  return {
    partySize,
    requestedStart,
    customerName: customerName || "Phone Guest",
  };
}

async function processLLMMessage(body) {
  console.log("WEBSOCKET LLM CONTROLLER HIT");
  console.log("Processing WS body:", JSON.stringify(body));

  const interactionType = body.interaction_type || body.type || "unknown";

  if (interactionType === "ping_pong") {
    return null;
  }

  if (!["response_required", "reminder_required"].includes(interactionType)) {
    console.log("Skipping event:", interactionType);
    return null;
  }

  const transcript = Array.isArray(body.transcript)
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

Rules:
- Ask only ONE question at a time.
- Keep responses short.
- Do NOT claim a booking is confirmed unless the system confirms it.
- If you still need missing details, ask only for the next missing detail.
      `.trim(),
    },
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
    const callId = body.call_id;

    if (!callId) {
      console.warn("No callId received in WS payload");
      return { response: aiReply };
    }

    if (interactionType !== "response_required") {
      return { response: aiReply };
    }

    const existingBooking = await Booking.findOne({
      callId,
      status: { $in: ["confirmed", "seated"] },
    })
      .sort({ createdAt: -1 })
      .lean();

    if (existingBooking) {
      console.log("Booking already exists for call:", callId, existingBooking._id);
      return { response: "Your reservation is already confirmed." };
    }

    const { partySize, requestedStart, customerName } =
      extractBookingDataFromTranscript(transcript);

    if (!partySize || !requestedStart) {
      return { response: aiReply };
    }

    console.log("📅 Booking intent detected", {
      callId,
      partySize,
      requestedStart,
      customerName,
    });

    const call = await Call.findOne({ callId }).lean();

    if (!call) {
      console.warn("Call not found:", callId);
      return { response: aiReply };
    }

    const agent = await Agent.findById(call.agentId).lean();

    if (!agent) {
      console.warn("Agent not found:", call.agentId);
      return { response: aiReply };
    }

    try {
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

      console.log("AI booking engine result:", result);

      if (result?.success) {
        return { response: "Perfect. Your table is confirmed." };
      }

      if (result?.suggestedTime) {
        const suggestedDate = new Date(result.suggestedTime);
        const suggestedLabel = suggestedDate.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });

        return {
          response: `We are full at that time. Would ${suggestedLabel} work instead?`,
        };
      }
    } catch (bookingError) {
      console.error("Booking engine error:", bookingError);
    }

    return { response: aiReply };
  } catch (err) {
    console.error("AI error:", err);

    return {
      response: "Sorry, could you repeat that please?",
    };
  }
}

module.exports = { processLLMMessage };