// src/controllers/llmSocketController.js

const Agent = require("../models/Agent");
const Call = require("../models/Call");
const Booking = require("../models/Booking");
const { getAIResponse } = require("../services/aiChatService");
const { findNearestAvailableSlot } = require("../services/bookingService");

/**
 * ================================
 * COMBINED AI EXTRACTION + RESPONSE
 * ================================
 */
async function extractAndRespond(text, currentDraft, transcript) {
  if (!text || text.trim().length < 1) return { extracted: {}, response: null };

  const recentConvo = (transcript ?? [])
    .slice(-6)
    .map(t => `${t.role === "agent" ? "Agent" : "Customer"}: ${t.content}`)
    .join("\n");

  const prompt = `You are a friendly restaurant receptionist handling a phone reservation.

Current booking status:
- Party size: ${currentDraft.partySize ?? "not collected"}
- Time: ${currentDraft.requestedStart ? new Date(currentDraft.requestedStart).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }) : "not collected"}
- Name: ${currentDraft.customerName ?? "not collected"}

Recent conversation:
${recentConvo}

Customer just said: "${text}"

Your job:
1. Extract any booking info the customer just provided
2. Respond naturally as a receptionist to move the booking forward

Rules:
- Ask for ONE missing field at a time
- Never ask for phone number or date
- Keep response short and warm, like a real person on the phone
- If all 3 fields are collected, return null for response

Respond ONLY with this JSON:
{
  "extracted": {
    "partySize": <number or null>,
    "time": "<HH:MM or null>",
    "name": "<string or null>"
  },
  "response": "<your natural reply or null if all fields collected>"
}

Only JSON. No markdown. No explanation.`;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 150,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content?.trim() ?? "{}";
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    console.log("🎯 Combined extraction + response:", parsed);
    return {
      extracted: parsed.extracted ?? {},
      response: parsed.response ?? null,
    };

  } catch (err) {
    console.error("❌ OpenAI combined error:", err.message);
    return { extracted: {}, response: null };
  }
}

/**
 * ================================
 * BOOKING INTENT DETECTION
 * ================================
 */
function looksLikeBookingIntent(text) {
  if (!text) return false;
  return /\b(book|reserve|reservation|table)\b/i.test(text);
}

/**
 * ================================
 * IN-MEMORY LOCK
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
   * PHONE NUMBER — LOG ALL CANDIDATES
   * ================================
   */
  console.log("📞 Full body.call object:", JSON.stringify(body.call ?? {}));
  console.log("📞 Phone candidates:", {
    from_number: body?.call?.from_number,
    caller_id: body?.call?.caller_id,
    from: body?.call?.from,
    customer_number: body?.call?.customer_number,
    from_number_body: body?.from_number,
  });

  const phoneFromBody =
    body?.call?.from_number ||
    body?.call?.caller_id ||
    body?.call?.from ||
    body?.call?.customer_number ||
    body?.from_number ||
    null;

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

  const transcript = body.transcript ?? [];

  /**
   * ================================
   * DRAFT STATE
   * ================================
   */
  const freshCall = await Call.findOne({ _id: call._id }).lean();
  let draft = {
    partySize:      freshCall.bookingDraft?.partySize      ?? null,
    requestedStart: freshCall.bookingDraft?.requestedStart ?? null,
    customerName:   freshCall.bookingDraft?.customerName   ?? null,
    customerPhone:  freshCall.bookingDraft?.customerPhone  ?? freshCall.callerNumber ?? phoneFromBody ?? null,
  };

  /**
   * ================================
   * BOOKING FLOW DETECTION
   * ================================
   */
  const recentTranscriptText = transcript
    .slice(-4)
    .map(t => t.content)
    .join(" ");

  const bookingFlowActive =
    !!draft.partySize ||
    !!draft.requestedStart ||
    !!draft.customerName ||
    looksLikeBookingIntent(latestUserText) ||
    looksLikeBookingIntent(recentTranscriptText);

  /**
   * ================================
   * BOOKING FLOW
   * ================================
   */
  if (bookingFlowActive) {

    const { extracted, response: aiResponse } = await extractAndRespond(latestUserText, draft, transcript);

    console.log("🧠 Extracted:", extracted);

    if (extracted.partySize && !draft.partySize) {
      draft.partySize = extracted.partySize;
    }

    if (extracted.time && !draft.requestedStart) {
      try {
        const [h, m] = extracted.time.split(":").map(Number);
        const d = new Date();
        d.setHours(h, m || 0, 0, 0);
        draft.requestedStart = d;
      } catch (e) {
        console.error("❌ Time parsing error:", e);
      }
    }

    if (extracted.name && !draft.customerName) {
      draft.customerName = extracted.name;
    }

    await Call.updateOne(
      { _id: call._id },
      {
        $set: {
          "bookingDraft.partySize":      draft.partySize,
          "bookingDraft.requestedStart": draft.requestedStart,
          "bookingDraft.customerName":   draft.customerName,
          "bookingDraft.customerPhone":  draft.customerPhone,
        },
      }
    );

    console.log("📋 Draft after update:", draft);

    /**
     * ================================
     * STILL MISSING FIELDS
     * ================================
     */
    if (!draft.partySize || !draft.requestedStart || !draft.customerName) {
      const fallback =
        !draft.partySize ? "How many people will be joining you?" :
        !draft.requestedStart ? "What time works for you?" :
        "And the name for the reservation?";

      return { response: aiResponse || fallback };
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
        businessId:      agent.businessId,
        requestedStart:  draft.requestedStart,
        durationMinutes: 90,
        partySize:       draft.partySize,
        source:          "ai",
        agentId:         agent._id,
        callId,
        customerName:    draft.customerName,
        customerPhone:   draft.customerPhone,
      });

      if (result?.success && result.booking) {
        console.log("✅ Booking confirmed:", result.booking._id);

        await Call.updateOne(
          { _id: call._id },
          {
            $set: {
              "bookingDraft.partySize":      null,
              "bookingDraft.requestedStart": null,
              "bookingDraft.customerName":   null,
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
        response: "I'm sorry, we don't have availability for that time. Would you like to try a different time?",
      };

    } catch (err) {
      console.error("❌ Booking error FULL:", JSON.stringify(err, null, 2));
      console.error("❌ Booking error message:", err.message);
      console.error("❌ Booking error stack:", err.stack);
      return {
        response: "I'm sorry, something went wrong while making the reservation. Please try again.",
      };
    } finally {
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