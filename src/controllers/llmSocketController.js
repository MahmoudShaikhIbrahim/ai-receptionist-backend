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
 * EXTRACTION HELPERS
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
    /\bjust (\d+)\b/i,
    // ✅ FIX 1: Standalone number as last fallback (e.g. "Two." → "2." after wordsToNumbers)
    /^\s*(\d+)\s*\.?\s*$/,
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

  // ✅ FIX 2: Only match a time if it has context (at/around/etc.) OR explicit AM/PM.
  // A bare number like "1" by itself will NOT match here — it must have a prefix word
  // or AM/PM. Exception: we also allow bare numbers 1–11 with no AM/PM only when
  // accompanied by a time-context word, and assume PM for restaurant hours.
  const match =
    // Priority 1: context word + number + optional AM/PM  (e.g. "at 1", "around 7pm")
    normalized.match(
      /\b(?:at|around|maybe|for)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i
    ) ||
    // Priority 2: number + explicit AM/PM, no context word needed  (e.g. "7pm", "1:30am")
    normalized.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);

  if (!match) return null;

  let hour = parseInt(match[1], 10);
  let minute = match[2] ? parseInt(match[2], 10) : 0;
  const meridiem = match[3]?.toLowerCase();

  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (minute < 0 || minute > 59) return null;

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
  } else {
    // No AM/PM stated — assume PM for restaurant hours (1–11 → 13–23)
    if (hour >= 1 && hour <= 11) hour += 12;
    if (hour === 0) return null;
  }

  const date = new Date();
  date.setHours(hour, minute, 0, 0);

  return date;
}

function extractNameFromText(text) {
  if (!text) return null;

  const normalized = text.trim();

  const patterns = [
    /\bmy name is\s+([a-z][a-z\s'-]{1,40})/i,
    /\bi am\s+([a-z][a-z\s'-]{1,40})/i,
    /\bi'm\s+([a-z][a-z\s'-]{1,40})/i,
    /\bthis is\s+([a-z][a-z\s'-]{1,40})/i,
    /\bname[''s]*\s+(?:is\s+)?([a-z][a-z\s'-]{1,40})/i,
    /\bput it under\s+([a-z][a-z\s'-]{1,40})/i,
    /\bunder\s+([a-z][a-z\s'-]{1,40})/i,
    /\bbook.*under\s+([a-z][a-z\s'-]{1,40})/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) {
      return match[1]
        .trim()
        .replace(/[^a-z\s'-]/gi, "")
        .replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }

  // ✅ Already correct: bare single name like "Mahmoud" is accepted
  if (
    /^[a-zA-Z][a-zA-Z\s'-]{0,40}$/.test(normalized) &&
    normalized.split(" ").length <= 3 &&
    normalized.length >= 2
  ) {
    return normalized
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  return null;
}

function looksLikeBookingIntent(text) {
  if (!text) return false;
  return /\b(book|reserve|reservation|table)\b/i.test(text);
}

/**
 * ================================
 * IN-MEMORY LOCK (Fix 3 — prevent duplicate concurrent bookings)
 * ================================
 */
const processingCalls = new Set();

/**
 * ================================
 * MAIN CONTROLLER
 * ================================
 */
async function processLLMMessage(body, req) {
  console.log("🎯 WEBSOCKET LLM CONTROLLER HIT");

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
    console.warn("⚠️ No callId found");
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
    console.warn("⚠️ Call not found:", callId);
    return { response: "Sorry, something went wrong." };
  }

  /**
   * ================================
   * RECOVER PHONE FROM RETELL BODY
   * ================================
   */
  const phoneFromBody =
    body?.call?.from_number ||
    body?.from_number ||
    body?.caller_id ||
    body?.call?.caller_id ||
    null;

  console.log("📞 Phone fields from body:", {
    call_from_number: body?.call?.from_number,
    body_from_number: body?.from_number,
    body_caller_id: body?.caller_id,
    call_caller_id: body?.call?.caller_id,
  });

  if (!call.callerNumber && phoneFromBody) {
    await Call.updateOne(
      { _id: call._id },
      { $set: { callerNumber: phoneFromBody } }
    );
    call.callerNumber = phoneFromBody;
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
  const freshCall = await Call.findOne({ _id: call._id }).lean();
  let draft = {
    partySize: freshCall.bookingDraft?.partySize ?? null,
    requestedStart: freshCall.bookingDraft?.requestedStart ?? null,
    customerName: freshCall.bookingDraft?.customerName ?? null,
    customerPhone: freshCall.bookingDraft?.customerPhone ?? freshCall.callerNumber ?? null,
  };

  const bookingFlowActive =
    !!draft.partySize ||
    !!draft.requestedStart ||
    !!draft.customerName ||
    looksLikeBookingIntent(latestUserText);

  /**
   * ================================
   * BOOKING FLOW
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
      {
        $set: {
          "bookingDraft.partySize": draft.partySize,
          "bookingDraft.requestedStart": draft.requestedStart,
          "bookingDraft.customerName": draft.customerName,
          "bookingDraft.customerPhone": draft.customerPhone,
        },
      }
    );

    console.log("📋 Draft after update:", draft);

    /**
     * ================================
     * STRICT STEP-BY-STEP QUESTIONS
     * ================================
     */
    if (!draft.partySize) {
      return { response: "How many people will be dining?" };
    }

    if (!draft.requestedStart) {
      return { response: "What time would you like the reservation? Just say the hour, like 7 or 8." };
    }

    if (!draft.customerName) {
      return { response: "What name should I put the reservation under?" };
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
        response: `Your reservation is already confirmed under ${draft.customerName}. We look forward to seeing you!`,
        end_call: true,
      };
    }

    // ✅ FIX 3: In-memory lock to prevent duplicate concurrent booking attempts
    if (processingCalls.has(callId)) {
      console.log("⏭ Already processing booking for:", callId);
      return { response: "One moment please..." };
    }
    processingCalls.add(callId);

    const agent = await Agent.findById(call.agentId).lean();

    if (!agent) {
      processingCalls.delete(callId);
      return { response: "Sorry, something went wrong finding the restaurant." };
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
        console.log("✅ Booking confirmed:", result.booking._id);

        await Call.updateOne(
          { _id: call._id },
          {
            $set: {
              "bookingDraft.partySize": null,
              "bookingDraft.requestedStart": null,
              "bookingDraft.customerName": null,
            },
          }
        );

        const timeString = new Date(
          result.booking.startIso
        ).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });

        return {
          response: `Perfect! Your table for ${draft.partySize} is confirmed at ${timeString} under ${draft.customerName}. We look forward to seeing you!`,
          end_call: true,
        };
      }

      if (result?.suggestedTime) {
        const suggested = new Date(result.suggestedTime).toLocaleTimeString(
          "en-US",
          { hour: "numeric", minute: "2-digit", hour12: true }
        );

        return {
          response: `We're fully booked at that time. Would ${suggested} work for you instead?`,
        };
      }

      return {
        response:
          "I'm sorry, we don't have availability for that time. Would you like to try a different time?",
      };
    } catch (err) {
      console.error("❌ Booking error:", err);
      return {
        response:
          "I'm sorry, something went wrong while making the reservation. Please try again.",
      };
    } finally {
      // ✅ Always release the lock
      processingCalls.delete(callId);
    }
  }

  /**
   * ================================
   * NON-BOOKING → AI FALLBACK
   * ================================
   */
  const aiReply = await getAIResponse([
    {
      role: "system",
      content:
        "You are a friendly and professional restaurant receptionist. Keep responses short and natural, suitable for a phone call. If the customer wants to make a reservation, let them know you can help with that.",
    },
    {
      role: "user",
      content: latestUserText || "Hello",
    },
  ]);

  return { response: aiReply || "How can I help you today?" };
}

module.exports = { processLLMMessage };