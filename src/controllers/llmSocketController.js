const Agent = require("../models/Agent");
const Call = require("../models/Call");
const Booking = require("../models/Booking");
const { wordsToNumbers } = require("words-to-numbers");
const { getAIResponse } = require("../services/aiChatService");
const { findNearestAvailableSlot } = require("../services/bookingService");

function normalizeText(value) {
  if (typeof value !== "string") return "";

  const converted = wordsToNumbers(value.toLowerCase());
  return String(converted).trim();
}

function extractPartySizeFromText(text) {
  if (!text || typeof text !== "string") return null;

  const normalized = normalizeText(text);

  const patterns = [
    /table for (\d+)/i,
    /party of (\d+)/i,
    /for (\d+) people/i,
    /for (\d+)/i
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) {
      const value = parseInt(match[1], 10);
      if (value >= 1 && value <= 50) return value;
    }
  }

  const numbers = normalized.match(/\b\d+\b/g);

  if (numbers) {
    for (const n of numbers) {
      const value = parseInt(n, 10);

      const timePattern = new RegExp(`${value}\\s?(am|pm)`, "i");
      if (timePattern.test(normalized)) continue;

      if (value >= 1 && value <= 50) return value;
    }
  }

  return null;
}

function extractTimeFromText(text) {
  if (!text) return null;

  const normalized = text.toLowerCase().trim();

  const colonMatch = normalized.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i);
  const meridiemMatch = normalized.match(/\b(\d{1,2})\s*(am|pm)\b/i);

  let hour;
  let minute;
  let meridiem;

  if (colonMatch) {
    hour = parseInt(colonMatch[1], 10);
    minute = parseInt(colonMatch[2], 10);
    meridiem = colonMatch[3] ? colonMatch[3].toLowerCase() : null;
  } else if (meridiemMatch) {
    hour = parseInt(meridiemMatch[1], 10);
    minute = 0;
    meridiem = meridiemMatch[2].toLowerCase();
  } else {
    return null;
  }

  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (minute < 0 || minute > 59) return null;

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
  } else {
    if (hour < 0 || hour > 23) return null;
  }

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

async function processLLMMessage(body, req) {
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

Collect the following information:
- number of people
- reservation time
- customer name

Rules:
- Ask only ONE question at a time.
- Keep responses short and natural.
- When information is missing, ask for the missing detail.
- Once all details are collected, wait for the system to check availability.
- When the system confirms the reservation, tell the customer their table is confirmed.
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

    // 🔧 FIX: safely extract callId
    let callId =
      body?.call_id ||
      body?.callId ||
      body?.metadata?.call_id ||
      null;

    if (!callId && req?.url) {
      const parts = req.url.split("/");
      const possibleId = parts[parts.length - 1];

      if (possibleId && possibleId.startsWith("call_")) {
        callId = possibleId;
      }
    }

    if (!callId) {
      console.warn("No callId received in WS payload or URL");
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

console.log("📊 Extracted booking data:", {
  partySize,
  requestedStart,
  customerName,
  callId,
});

/*
 Only block booking if party size OR time is missing.
 Do NOT block if customerName is missing.
*/
if (!partySize || !requestedStart || !customerName) {
  return { response: aiReply };
}

console.log("📅 Booking intent detected", {
  callId,
  partySize,
  requestedStart,
  customerName,
});

   const call = await Call.findOne({
  $or: [{ callId }, { call_id: callId }]
}).lean();

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
        customerPhone: call?.fromNumber || call?.from || null,
        notes: null,
        searchWindowMinutes: 120,
      });

      console.log("AI booking engine result:", result);

      if (result?.success) {
        return {
  response: "Alright. Your table is confirmed. We look forward to seeing you.",
  end_call: true
};
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
    console.error("AI error:", {
  message: err?.message,
  stack: err?.stack,
  body,
});

    return {
      response: "Sorry, could you repeat that please?",
    };
  }
}

module.exports = { processLLMMessage };