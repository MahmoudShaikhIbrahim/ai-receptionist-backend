// src/controllers/llmSocketController.js

const Agent = require("../models/Agent");
const Call = require("../models/Call");
const Booking = require("../models/Booking");
const { wordsToNumbers } = require("words-to-numbers");
const { getAIResponse } = require("../services/aiChatService");
const { findNearestAvailableSlot } = require("../services/bookingService");

function normalizeText(value) {
  if (typeof value !== "string") return "";

  const protectedText = value.replace(/\bI\b/g, "__PRONOUN_I__");
  const converted = wordsToNumbers(protectedText.toLowerCase());
  return String(converted).replace(/__pronoun_i__/g, "i").trim();
}

function extractPartySizeFromText(text) {
  if (!text || typeof text !== "string") return null;

  const normalized = normalizeText(text);

  const strongPatterns = [
    /table for (\d+)/i,
    /party of (\d+)/i,
    /for (\d+) people/i,
    /we are (\d+)/i,
    /there are (\d+) of us/i,
    /(\d+)\s+people/i,
    /(\d+)\s+persons?/i,
  ];

  for (const pattern of strongPatterns) {
    const match = normalized.match(pattern);
    if (match) {
      const value = parseInt(match[1], 10);
      if (value >= 1 && value <= 50) return value;
    }
  }

  const bareNumberMatch = normalized.match(/^\s*(\d{1,2})\s*\.?\s*$/);
  if (bareNumberMatch) {
    const value = parseInt(bareNumberMatch[1], 10);
    if (value >= 1 && value <= 50) return value;
  }

  return null;
}

function extractTimeFromText(text) {
  if (!text || typeof text !== "string") return null;

  const normalized = text.toLowerCase().trim();

  const colonMatch = normalized.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i);
  const meridiemMatch = normalized.match(/\b(?:at\s+)?(\d{1,2})\s*(am|pm)\b/i);
  const bareHourMatch = normalized.match(/^(?:at\s+)?(\d{1,2})\.?$/i);

  let hour;
  let minute = 0;
  let meridiem = null;

  if (colonMatch) {
    hour = parseInt(colonMatch[1], 10);
    minute = parseInt(colonMatch[2], 10);
    meridiem = colonMatch[3] ? colonMatch[3].toLowerCase() : null;
  } else if (meridiemMatch) {
    hour = parseInt(meridiemMatch[1], 10);
    meridiem = meridiemMatch[2].toLowerCase();
  } else if (bareHourMatch) {
    hour = parseInt(bareHourMatch[1], 10);
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
    // bare number like "6" => assume evening reservation by default if 1-11
    if (hour < 1 || hour > 23) return null;
    if (hour >= 1 && hour <= 11) {
      hour += 12;
    }
  }

  const requestedStart = new Date();
  requestedStart.setHours(hour, minute, 0, 0);

  return requestedStart;
}

function extractNameFromText(text) {
  if (!text || typeof text !== "string") return null;

  const normalized = text.trim();

  const patterns = [
    /\bmy name is\s+([a-z][a-z\s'-]{1,49})\b/i,
    /\bthis is\s+([a-z][a-z\s'-]{1,49})\b/i,
    /\bit'?s\s+([a-z][a-z\s'-]{1,49})\b/i,
    /\bi am\s+([a-z][a-z\s'-]{1,49})\b/i,
    /\bi'm\s+([a-z][a-z\s'-]{1,49})\b/i,
    /\bname is\s+([a-z][a-z\s'-]{1,49})\b/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
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

  // Fallback for simple answer like "Mahmoud" or "Mahmoud Ibrahim"
  if (/^[a-z][a-z\s'-]{1,49}$/i.test(normalized)) {
    const cleaned = normalized.replace(/\s+/g, " ").trim();

    const blocked = [
      "yes",
      "no",
      "okay",
      "ok",
      "hello",
      "hi",
      "bye",
      "thanks",
      "thank you",
      "today",
      "tomorrow",
    ];

    if (!blocked.includes(cleaned.toLowerCase())) {
      return cleaned
        .split(" ")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
        .join(" ");
    }
  }

  return null;
}

function looksLikeBookingIntent(text) {
  if (!text || typeof text !== "string") return false;
  return /\b(book|booking|reserve|reservation|table)\b/i.test(text);
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

async function processLLMMessage(body, req) {
  console.log("WEBSOCKET LLM CONTROLLER HIT");
  console.log("Processing WS body:", JSON.stringify(body));

  const interactionType = body.interaction_type || body.type || "unknown";

  if (interactionType === "ping_pong") {
    return null;
  }

  if (interactionType !== "response_required") {
    console.log("Skipping event:", interactionType);
    return null;
  }

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

  const transcript = Array.isArray(body.transcript)
    ? body.transcript
    : Array.isArray(body.transcript_json)
    ? body.transcript_json
    : [];

  const latestUserText =
    typeof body.latest_user_text === "string"
      ? body.latest_user_text.trim()
      : "";

  const messages = [
    {
      role: "system",
      content: `
You are a friendly restaurant receptionist.

Your job is to help customers reserve tables.

Rules:
- Ask only ONE question at a time.
- Keep responses short and natural.
- If the customer is booking, collect:
  1) number of people
  2) reservation time
  3) customer name
- Do not say the table is confirmed unless the system confirms it.
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

    if (!callId) {
      console.warn("No callId received in WS payload or URL");
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
      return {
        response: "Your reservation is already confirmed.",
        end_call: true,
      };
    }

    const call = await Call.findOne({
      $or: [{ callId }, { call_id: callId }],
    });

    if (!call) {
      console.warn("Call not found:", callId);
      return { response: aiReply };
    }

    let draft = call.bookingData || {
      partySize: null,
      requestedStart: null,
      customerName: null,
      customerPhone: call.callerNumber || null,
    };

    const bookingFlowActive =
      looksLikeBookingIntent(latestUserText) ||
      !!draft.partySize ||
      !!draft.requestedStart ||
      !!draft.customerName;

    if (bookingFlowActive) {
      if (!draft.partySize) {
        const size = extractPartySizeFromText(latestUserText);
        if (size) draft.partySize = size;
      }

      if (!draft.requestedStart) {
        const time = extractTimeFromText(latestUserText);
        if (time) draft.requestedStart = time;
      }

      if (!draft.customerName) {
        const name = extractNameFromText(latestUserText);
        if (name) draft.customerName = name;
      }

      await Call.updateOne(
        { _id: call._id },
        { $set: { bookingData: draft } }
      );

      call.bookingData = draft;

      console.log("📊 Reservation draft:", {
        callId,
        latestUserText,
        reservationDraft: draft,
      });

      const { partySize, requestedStart, customerName, customerPhone } = draft;

      const nextQuestion = getNextMissingQuestion(draft);

      if (nextQuestion) {
        return { response: nextQuestion };
      }

      const agent = await Agent.findById(call.agentId).lean();

      if (!agent) {
        console.warn("Agent not found:", call.agentId);
        return { response: aiReply };
      }

      console.log("📅 Booking intent detected", {
        callId,
        partySize,
        requestedStart,
        customerName,
        customerPhone,
      });

      try {
        console.log("🚀 Attempting booking:", {
          callId,
          partySize,
          requestedStart,
          customerName,
          customerPhone,
        });

        const result = await findNearestAvailableSlot({
          businessId: agent.businessId,
          requestedStart,
          durationMinutes: 90,
          partySize,
          source: "ai",
          agentId: agent._id,
          callId,
          customerName,
          customerPhone: customerPhone || null,
          notes: null,
          searchWindowMinutes: 120,
        });

        console.log("AI booking engine result:", result);

        if (result && result.success && result.booking) {
          console.log("✅ Booking saved:", result.booking._id);

          call.bookingData = {
            bookingId: result.booking._id,
            partySize,
            requestedStart,
            customerName,
            customerPhone: customerPhone || null,
          };

          await call.save();

          return {
            response: "Perfect. Your table is confirmed.",
            end_call: true,
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

        return {
          response: "I'm sorry, I couldn't confirm the reservation right now. Please try again.",
        };
      } catch (bookingError) {
        console.error("Booking engine error:", bookingError);

        return {
          response: "I'm sorry, I couldn't confirm the reservation right now. Please try again.",
        };
      }
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