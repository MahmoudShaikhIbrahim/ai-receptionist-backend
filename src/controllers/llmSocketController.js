// src/controllers/llmSocketController.js

const Agent = require("../models/Agent");
const Call = require("../models/Call");
const Booking = require("../models/Booking");
const { wordsToNumbers } = require("words-to-numbers");
const { getAIResponse } = require("../services/aiChatService");
const { findNearestAvailableSlot } = require("../services/bookingService");

const recentBookingAttempts = new Map();
const BOOKING_ATTEMPT_TTL_MS = 2 * 60 * 1000;

function normalizeText(value) {
  if (typeof value !== "string") return "";
  return wordsToNumbers(value.toLowerCase()).trim();
}

function cleanupRecentBookingAttempts() {
  const now = Date.now();

  for (const [key, value] of recentBookingAttempts.entries()) {
    if (!value || value.expiresAt <= now) {
      recentBookingAttempts.delete(key);
    }
  }
}

function buildBookingSignature({ partySize, requestedStart, customerName }) {
  const timeKey =
    requestedStart instanceof Date && !Number.isNaN(requestedStart.getTime())
      ? requestedStart.toISOString()
      : "no-time";

  const sizeKey = partySize || "no-party";
  const nameKey = (customerName || "phone-guest").trim().toLowerCase();

  return `${sizeKey}__${timeKey}__${nameKey}`;
}

function wasRecentlyAttempted(callId, signature) {
  cleanupRecentBookingAttempts();

  const key = `${callId}::${signature}`;
  const existing = recentBookingAttempts.get(key);

  if (!existing) return false;
  if (existing.expiresAt <= Date.now()) {
    recentBookingAttempts.delete(key);
    return false;
  }

  return true;
}

function markRecentlyAttempted(callId, signature) {
  cleanupRecentBookingAttempts();

  const key = `${callId}::${signature}`;
  recentBookingAttempts.set(key, {
    expiresAt: Date.now() + BOOKING_ATTEMPT_TTL_MS,
  });
}

function extractPartySizeFromText(text) {
  if (!text) return null;

  const phrasePatterns = [
    /\btable for (\d{1,2})\b/i,
    /\bfor (\d{1,2}) people\b/i,
    /\bparty of (\d{1,2})\b/i,
    /\bwe are (\d{1,2})\b/i,
    /\bthere (?:will be|are) (\d{1,2})\b/i,
    /\bbooking for (\d{1,2})\b/i,
    /\breservation for (\d{1,2})\b/i,
    /\b(\d{1,2}) people\b/i,
    /\b(\d{1,2}) guests\b/i,
    /\b(\d{1,2}) persons\b/i,
  ];

  for (const pattern of phrasePatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const value = parseInt(match[1], 10);
      if (value > 0 && value <= 50) return value;
    }
  }

  const wordMap = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
  };

  const wordPatterns = [
    /\btable for (one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i,
    /\bfor (one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) people\b/i,
    /\bparty of (one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i,
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) people\b/i,
    /\bwe are (one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i,
  ];

  for (const pattern of wordPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const value = wordMap[match[1].toLowerCase()];
      if (value > 0 && value <= 50) return value;
    }
  }

  return null;
}

function inferRestaurantHour(hour, text) {
  const normalizedText = normalizeText(text);

  if (/\b(am)\b/i.test(normalizedText)) {
    return hour === 12 ? 0 : hour;
  }

  if (/\b(pm)\b/i.test(normalizedText)) {
    return hour < 12 ? hour + 12 : hour;
  }

  if (/\b(morning|breakfast)\b/i.test(normalizedText)) {
    return hour === 12 ? 0 : hour;
  }

  if (/\b(noon)\b/i.test(normalizedText)) {
    return 12;
  }

  if (/\b(afternoon|lunch)\b/i.test(normalizedText)) {
    if (hour >= 1 && hour <= 11) return hour + 12;
    return hour;
  }

  if (/\b(evening|tonight|dinner|night)\b/i.test(normalizedText)) {
    if (hour >= 1 && hour <= 11) return hour + 12;
    return hour;
  }

  // Restaurant-friendly default:
  // bare "7" becomes 19:00, bare "8:30" becomes 20:30
  if (hour >= 1 && hour <= 11) {
    return hour + 12;
  }

  return hour;
}

function createRequestedStart(hour24, minute) {
  if (!Number.isInteger(hour24) || !Number.isInteger(minute)) return null;
  if (hour24 < 0 || hour24 > 23) return null;
  if (minute < 0 || minute > 59) return null;

  const requestedStart = new Date();
  requestedStart.setSeconds(0, 0);
  requestedStart.setHours(hour24, minute, 0, 0);

  return requestedStart;
}

function extractTimeFromText(text) {
  if (!text) return null;

  const normalizedText = normalizeText(text);

  if (/\bnow\b/i.test(normalizedText)) {
    const now = new Date();
    now.setSeconds(0, 0);
    return now;
  }

  if (/\bnoon\b/i.test(normalizedText)) {
    return createRequestedStart(12, 0);
  }

  if (/\bmidnight\b/i.test(normalizedText)) {
    return createRequestedStart(0, 0);
  }

  const explicitPatterns = [
    /\b(?:at|for|around|about)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i,
    /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i,
    /\b(?:at|for|around|about)\s+(\d{1,2}):(\d{2})\b/i,
    /\b(?:at|for|around|about)\s+(\d{1,2})\b/i,
    /\b(\d{1,2}):(\d{2})\b/i,
  ];

  for (const pattern of explicitPatterns) {
    const match = normalizedText.match(pattern);
    if (!match) continue;

    let hour = parseInt(match[1], 10);
    const minute = parseInt(match[2] || "0", 10);
    const meridiem = match[3] ? match[3].toLowerCase() : null;

    if (!Number.isInteger(hour) || !Number.isInteger(minute)) continue;
    if (hour < 1 || hour > 12 && !meridiem) continue;
    if (minute < 0 || minute > 59) continue;

    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    if (!meridiem) hour = inferRestaurantHour(hour, normalizedText);

    const requestedStart = createRequestedStart(hour, minute);
    if (requestedStart) return requestedStart;
  }

  const namedTimePatterns = [
    /\b(?:at|for|around|about)\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i,
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(am|pm)\b/i,
  ];

  const wordToHour = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
  };

  for (const pattern of namedTimePatterns) {
    const match = normalizedText.match(pattern);
    if (!match?.[1]) continue;

    let hour = wordToHour[match[1].toLowerCase()];
    const meridiem = match[2] ? match[2].toLowerCase() : null;

    if (!hour) continue;

    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    if (!meridiem) hour = inferRestaurantHour(hour, normalizedText);

    const requestedStart = createRequestedStart(hour, 0);
    if (requestedStart) return requestedStart;
  }

  return null;
}

function extractNameFromText(text) {
  if (!text) return null;

  const patterns = [
    /\bmy name is\s+([a-z][a-z\s'-]{1,49})\b/i,
    /\bthis is\s+([a-z][a-z\s'-]{1,49})\b/i,
    /\bit'?s\s+([a-z][a-z\s'-]{1,49})\b/i,
    /\bi am\s+([a-z][a-z\s'-]{1,49})\b/i,
    /\bi'm\s+([a-z][a-z\s'-]{1,49})\b/i,
    /\bname\s+([a-z][a-z\s'-]{1,49})\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const cleaned = match[1]
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\b(at|for|on|around|with|tonight|today)\b.*$/i, "")
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
    const content = utterance.content.trim();
    const normalized = normalizeText(content);

    if (!partySize) {
      partySize = extractPartySizeFromText(normalized);
    }

    if (!requestedStart) {
      requestedStart = extractTimeFromText(normalized);
    }

    if (!customerName) {
      customerName = extractNameFromText(content);
    }
  }

  return {
    partySize,
    requestedStart,
    customerName: customerName || "Phone Guest",
  };
}

function buildMessages(transcript) {
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
- If the customer already gave a detail, do not ask for it again.
- If only one detail is missing, ask only for that detail.
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

  return messages;
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

  const callId = body.call_id;

  try {
    const { partySize, requestedStart, customerName } =
      extractBookingDataFromTranscript(transcript);

    console.log("Extracted booking data:", {
      callId,
      partySize,
      requestedStart,
      customerName,
    });

    if (callId && partySize && requestedStart) {
      const existingBooking = await Booking.findOne({
        callId,
        status: { $in: ["confirmed", "seated"] },
      })
        .sort({ createdAt: -1 })
        .lean();

      if (existingBooking) {
        console.log("Booking already exists for call:", callId);
        return { response: "Your reservation is already confirmed." };
      }

      const signature = buildBookingSignature({
        partySize,
        requestedStart,
        customerName,
      });

      if (!wasRecentlyAttempted(callId, signature)) {
        console.log("Booking intent detected", {
          callId,
          partySize,
          requestedStart,
          customerName,
        });

        const call = await Call.findOne({
          $or: [{ callId }, { call_id: callId }],
        }).lean();

        if (!call) {
          console.warn("Call not found:", callId);
        } else {
          const agent = await Agent.findById(call.agentId).lean();

          if (!agent) {
            console.warn("Agent not found:", call.agentId);
          } else {
            markRecentlyAttempted(callId, signature);

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
          }
        }
      } else {
        console.log("Skipping repeated booking availability check for same call/signature", {
          callId,
          signature,
        });
      }
    }

    const messages = buildMessages(transcript);
    const aiReply = await getAIResponse(messages);

    if (!aiReply || typeof aiReply !== "string" || !aiReply.trim()) {
      return { response: "Could you repeat that please?" };
    }

    return { response: aiReply.trim() };
  } catch (err) {
    console.error("AI error:", err);

    return {
      response: "Sorry, could you repeat that please?",
    };
  }
}

module.exports = { processLLMMessage };