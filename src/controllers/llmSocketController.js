// src/controllers/llmSocketController.js

const Agent = require("../models/Agent");
const Call = require("../models/Call");
const Booking = require("../models/Booking");
const { wordsToNumbers } = require("words-to-numbers");
const { getAIResponse } = require("../services/aiChatService");
const { findNearestAvailableSlot } = require("../services/bookingService");

/**
 * ================================
 * NORMALIZATION
 * ================================
 */
function normalizeText(value) {
  if (typeof value !== "string") return "";

  const protectedText = value.replace(/\bI\b/g, "__PRONOUN_I__");
  const converted = wordsToNumbers(protectedText.toLowerCase());

  return String(converted)
    .replace(/__pronoun_i__/g, "i")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * ================================
 * EXTRACTION HELPERS (ROBUST)
 * ================================
 */

function extractPartySizeFromText(text) {
  if (!text) return null;

  const normalized = normalizeText(text);

  const patterns = [
    /table for (\d+)/i,
    /party of (\d+)/i,
    /for (\d+)/i,
    /(\d+)\s*(people|persons|guests)/i,
    /\bwe are (\d+)/i,
    /\b(\d+)\b/,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) {
      const value = parseInt(match[1], 10);
      if (value >= 1 && value <= 50) return value;
    }
  }

  return null;
}

function extractTimeFromText(text) {
  if (!text) return null;

  const normalized = normalizeText(text);

  /**
   * Handles:
   * - "uh maybe at 8 pm"
   * - "around 7:30"
   * - "I think 9"
   * - "at uh... 6"
   */

  const match = normalized.match(
    /\b(?:at\s+|around\s+|maybe\s+|for\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i
  );

  if (!match) return null;

  let hour = parseInt(match[1], 10);
  let minute = match[2] ? parseInt(match[2], 10) : 0;
  const meridiem = match[3];

  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (minute < 0 || minute > 59) return null;

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
  } else {
    if (hour >= 1 && hour <= 11) hour += 12;
  }

  const date = new Date();
  date.setHours(hour, minute, 0, 0);

  return date;
}

function extractNameFromText(text) {
  if (!text) return null;

  const patterns = [
    /\bmy name is\s+([a-z\s'-]+)/i,
    /\bi am\s+([a-z\s'-]+)/i,
    /\bi'm\s+([a-z\s'-]+)/i,
    /\bthis is\s+([a-z\s'-]+)/i,
    /\bit'?s\s+([a-z\s'-]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const cleaned = match[1].trim().split(" ")[0];

      if (cleaned.length >= 2) {
        return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
      }
    }
  }

  // fallback: single word name
  if (/^[a-z]{2,}$/i.test(text.trim())) {
    return text.trim().charAt(0).toUpperCase() + text.trim().slice(1).toLowerCase();
  }

  return null;
}

function looksLikeBookingIntent(text) {
  if (!text) return false;
  return /\b(book|reserve|reservation|table)\b/i.test(text);
}

function getNextMissingQuestion(draft) {
  if (!draft.partySize) {
    return "How many people will be in your party?";
  }

  if (!draft.requestedStart) {
    return "What time would you like to reserve the table?";
  }

  if (!draft.customerName) {
    return "What name should I put on the reservation?";
  }

  return null;
}

/**
 * ================================
 * MAIN CONTROLLER
 * ================================
 */
async function processLLMMessage(body, req) {
  console.log("WEBSOCKET LLM CONTROLLER HIT");

  const interactionType = body.interaction_type || body.type;

  if (interactionType === "ping_pong") return null;
  if (interactionType !== "response_required") return null;

  /**
   * ================================
   * CALL ID
   * ================================
   */
  let callId =
    body.call_id ||
    body.callId ||
    body?.metadata?.call_id ||
    null;

  if (!callId && req?.url) {
    const parts = req.url.split("/");
    const possibleId = parts[parts.length - 1];
    if (possibleId?.startsWith("call_")) callId = possibleId;
  }

  if (!callId) {
    console.warn("No callId");
    return { response: "Sorry, something went wrong." };
  }

  /**
   * ================================
   * LOAD CALL
   * ================================
   */
  const call = await Call.findOne({
    $or: [{ callId }, { call_id: callId }],
  });

  if (!call) {
    console.warn("Call not found:", callId);
    return { response: "Sorry, something went wrong." };
  }

  /**
   * ================================
   * USER TEXT
   * ================================
   */
  const latestUserText =
    typeof body.latest_user_text === "string"
      ? body.latest_user_text.trim()
      : "";

  /**
   * ================================
   * DRAFT STATE
   * ================================
   */
  let draft = call.bookingData || {
    partySize: null,
    requestedStart: null,
    customerName: null,
    customerPhone: call.callerNumber || null,
  };

  const bookingFlowActive =
    !!draft.partySize ||
    !!draft.requestedStart ||
    !!draft.customerName ||
    looksLikeBookingIntent(latestUserText);

  /**
   * ================================
   * BOOKING FLOW (NO AI HERE)
   * ================================
   */
  if (bookingFlowActive) {
    const size = extractPartySizeFromText(latestUserText);
    const time = extractTimeFromText(latestUserText);
    const name = extractNameFromText(latestUserText);

    if (size && !draft.partySize) draft.partySize = size;
    if (time && !draft.requestedStart) draft.requestedStart = time;
    if (name && !draft.customerName) draft.customerName = name;

    await Call.updateOne(
      { _id: call._id },
      { $set: { bookingData: draft } }
    );

    console.log("📊 Draft:", draft);

    const nextQuestion = getNextMissingQuestion(draft);

    if (nextQuestion) {
      return { response: nextQuestion };
    }

    /**
     * ================================
     * PREVENT DUPLICATE BOOKING
     * ================================
     */
    const existingBooking = await Booking.findOne({
      callId,
      status: { $in: ["confirmed", "seated"] },
    });

    if (existingBooking) {
      return {
        response: "Your reservation is already confirmed.",
        end_call: true,
      };
    }

    const agent = await Agent.findById(call.agentId).lean();

    if (!agent) {
      return { response: "Sorry, something went wrong." };
    }

    /**
     * ================================
     * BOOKING ENGINE
     * ================================
     */
    try {
      const result = await findNearestAvailableSlot({
        businessId: agent.businessId,
        requestedStart: draft.requestedStart,
        durationMinutes: 90,
        partySize: draft.partySize,
        source: "ai",
        agentId: agent._id,
        callId,
        customerName: draft.customerName,
        customerPhone: draft.customerPhone,
      });

      if (result?.success && result.booking) {
        console.log("✅ BOOKED:", result.booking._id);

        return {
          response: "Perfect. Your table is confirmed. We look forward to seeing you.",
          end_call: true,
        };
      }

      if (result?.suggestedTime) {
        const suggested = new Date(result.suggestedTime).toLocaleTimeString(
          "en-US",
          { hour: "numeric", minute: "2-digit", hour12: true }
        );

        return {
          response: `We are full at that time. Would ${suggested} work instead?`,
        };
      }

      return {
        response: "I'm sorry, I couldn't confirm the reservation right now.",
      };
    } catch (err) {
      console.error("Booking error:", err);
      return {
        response: "I'm sorry, something went wrong while booking.",
      };
    }
  }

  /**
   * ================================
   * NON-BOOKING → AI
   * ================================
   */
  const aiReply = await getAIResponse([
    {
      role: "system",
      content: "You are a friendly restaurant receptionist.",
    },
    {
      role: "user",
      content: latestUserText,
    },
  ]);

  return { response: aiReply };
}

module.exports = { processLLMMessage };