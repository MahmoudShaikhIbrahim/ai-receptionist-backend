// src/controllers/llmSocketController.js

const Agent = require("../models/Agent");
const Call = require("../models/Call");
const Booking = require("../models/Booking");
const { getAIResponse } = require("../services/aiChatService");
const { findNearestAvailableSlot } = require("../services/bookingService");

/**
 * ================================
 * AI EXTRACTION
 * ================================
 */
async function extractBookingDetails(text, currentDraft, transcript) {
  if (!text || text.trim().length < 1) return {};

  // Build last few messages for context
  const recentConvo = (transcript ?? [])
    .slice(-6)
    .map(t => `${t.role === "agent" ? "Agent" : "Customer"}: ${t.content}`)
    .join("\n");

  const prompt = `You are helping extract booking information from a phone call at a restaurant.

Recent conversation:
${recentConvo}

Current booking draft:
- Party size: ${currentDraft.partySize ?? "not collected yet"}
- Time: ${currentDraft.requestedStart ? new Date(currentDraft.requestedStart).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }) : "not collected yet"}
- Name: ${currentDraft.customerName ?? "not collected yet"}

The customer just said: "${text}"

Extract ONLY what the customer just provided. Be smart and natural about it:
- "four", "4", "just me and my wife" = partySize 2, "family of 5" = partySize 5
- "seven", "7pm", "around eight", "half past six", "19:00", "at 7" = time (assume PM for restaurant hours if no AM/PM)
- "Mahmoud", "it's Sarah", "John", "my name is Ali", "call it Hassan", any single name = name
- If they said "yes" to a question the agent asked, figure out what they confirmed from context

Respond ONLY with valid JSON. Include only fields you found. Examples:
{"partySize": 4}
{"time": "19:00"}
{"name": "Mahmoud"}
{"partySize": 2, "name": "Sarah"}
{"time": "20:30"}
{}

Only the JSON. No explanation. No markdown.`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
  "Content-Type": "application/json",
  "x-api-key": process.env.ANTHROPIC_API_KEY,
  "anthropic-version": "2023-06-01",
},
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 100,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json();
    const raw = data.content?.[0]?.text?.trim() ?? "{}";
    const clean = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error("❌ AI extraction error:", err);
    return {};
  }
}

/**
 * ================================
 * AI NATURAL RESPONSE
 * ================================
 */
async function generateNaturalResponse(draft, transcript) {
  const missingFields = [];
  if (!draft.partySize) missingFields.push("party size (how many people)");
  if (!draft.requestedStart) missingFields.push("reservation time");
  if (!draft.customerName) missingFields.push("name for the reservation");

  const conversationHistory = (transcript ?? []).map(t => ({
    role: t.role === "agent" ? "assistant" : "user",
    content: t.content,
  }));

  const systemPrompt = `You are a friendly and professional restaurant receptionist handling a phone reservation.

Current booking status:
- Party size: ${draft.partySize ?? "not collected"}
- Time: ${draft.requestedStart ? new Date(draft.requestedStart).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }) : "not collected"}
- Name: ${draft.customerName ?? "not collected"}

You still need to collect: ${missingFields.join(", ")}

Rules:
- Ask for ONE missing field at a time naturally
- Never repeat a question if the customer already answered it
- Never ask for a phone number
- Keep responses short, warm and conversational like a real human receptionist
- If the customer gave you something, acknowledge it briefly then ask for the next thing
- Do not use robotic phrases like "Could you please provide me with"
- Talk like a normal friendly person
- Never mention dates, only ask for time`;

  try {
    const response = await getAIResponse([
      { role: "system", content: systemPrompt },
      ...conversationHistory,
    ]);
    return response;
  } catch (err) {
    console.error("❌ AI response error:", err);
    if (!draft.partySize) return "How many people will be joining you?";
    if (!draft.requestedStart) return "What time works for you?";
    if (!draft.customerName) return "And what name should I put the reservation under?";
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
   * RECOVER PHONE FROM RETELL BODY
   * ================================
   */
  const phoneFromBody =
    body?.call?.from_number ||
    body?.from_number ||
    body?.caller_id ||
    body?.call?.caller_id ||
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
    customerPhone:  freshCall.bookingDraft?.customerPhone  ?? freshCall.callerNumber ?? null,
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

    // Use AI to extract details naturally
    const extracted = await extractBookingDetails(latestUserText, draft, transcript);

    console.log("🧠 AI extracted:", extracted);

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
     * STILL MISSING FIELDS — ASK NATURALLY
     * ================================
     */
    if (!draft.partySize || !draft.requestedStart || !draft.customerName) {
      const naturalResponse = await generateNaturalResponse(draft, transcript);
      return { response: naturalResponse };
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
      console.error("❌ Booking error:", err);
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