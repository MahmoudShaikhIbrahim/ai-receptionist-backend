// src/controllers/llmSocketController.js

const OpenAI = require("openai");
const Agent = require("../models/Agent");
const Call = require("../models/Call");
const Booking = require("../models/Booking");
const Order = require("../models/Order");
const { streamAIResponse } = require("../services/aiChatService");
const { findNearestAvailableSlot } = require("../services/bookingService");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * ================================
 * AGENT CACHE (avoids repeated DB lookups)
 * ================================
 */
const agentCache = new Map();
const AGENT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getCachedAgent(agentId) {
  const key = agentId.toString();
  const cached = agentCache.get(key);
  if (cached && Date.now() - cached.timestamp < AGENT_CACHE_TTL) {
    return cached.agent;
  }
  const agent = await Agent.findById(agentId).lean();
  if (agent) agentCache.set(key, { agent, timestamp: Date.now() });
  return agent;
}

/**
 * ================================
 * FORMAT MENU
 * ================================
 */
function formatMenu(menu) {
  if (!menu || menu.length === 0) return "";
  const available = menu.filter(i => i.available);
  if (!available.length) return "";
  return available.map(i => `${i.name} (${i.price} ${i.currency || "AED"})`).join(", ");
}

/**
 * ================================
 * FORMAT OPENING HOURS
 * ================================
 */
function formatOpeningHours(openingHours) {
  if (!openingHours) return "Hours not set.";
  const days = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];
  return days.map(day => {
    const h = openingHours[day];
    if (!h || h.closed) return `${day.charAt(0).toUpperCase() + day.slice(1)}: Closed`;
    if (!h.open && !h.close) return `${day.charAt(0).toUpperCase() + day.slice(1)}: Not set`;
    return `${day.charAt(0).toUpperCase() + day.slice(1)}: ${h.open}-${h.close}`;
  }).join(", ");
}

/**
 * ================================
 * BUILD SYSTEM PROMPT (general fallback)
 * ================================
 */
function buildSystemPrompt(agent) {
  const hasBookings = agent.features?.bookings !== false;
  const hasOrders   = agent.features?.orders === true;
  const hasDelivery = agent.features?.delivery === true;
  const hasPickup   = agent.features?.pickup === true;
  const hasDineIn   = agent.features?.dineIn !== false;

  const features = [];
  if (hasBookings) features.push("table reservations");
  if (hasOrders && hasDineIn) features.push("dine-in orders");
  if (hasOrders && hasPickup) features.push("pickup orders");
  if (hasOrders && hasDelivery) features.push("delivery orders");

  const base = agent.agentPrompt?.trim() ||
    `You are ${agent.agentName || "an AI receptionist"} at ${agent.businessName}. You are friendly and helpful.`;

  return `${base}
Services: ${features.join(", ") || "general inquiries"}.
Hours: ${formatOpeningHours(agent.openingHours)}
Rules: Customer already greeted — do NOT say hello again. Keep responses very short. No phone numbers.`;
}

/**
 * ================================
 * INTENT DETECTION
 * ================================
 */
function looksLikeBookingIntent(text) {
  return /\b(book|reserve|reservation|table)\b/i.test(text || "");
}

function looksLikeOrderIntent(text) {
  return /\b(order|food|eat|hungry|menu|delivery|pickup|take.?away|bring|want to eat)\b/i.test(text || "");
}

function looksLikeFarewell(text) {
  return /\b(bye|goodbye|good night|see you|gotta go|that.?s all|nothing else|all good|have a good)\b/i.test(text || "");
}

/**
 * ================================
 * STREAMING EXTRACTION + RESPONSE
 *
 * Output format (2 lines only):
 *   Line 1:  SPEAK: <response text>   ← OR the word DONE (no response needed)
 *   Line 2:  {"p":null,"t":null,"n":null,"ot":null,"i":[],"a":null}
 *
 * As soon as line 1 is complete (~10-20 tokens), sendChunk() is called so
 * Retell TTS can start speaking — cutting perceived latency to ~200-400ms.
 * ================================
 */
async function extractAndRespond(
  text, currentDraft, orderDraft, transcript, agent,
  { bookingOnly = false, sendChunk = null } = {}
) {
  if (!text || text.trim().length < 1) {
    return { extracted: {}, orderExtracted: {}, response: null, streamed: false };
  }

  const recentConvo = (transcript ?? [])
    .slice(-4)
    .map(t => `${t.role === "agent" ? "Agent" : "Customer"}: ${t.content}`)
    .join("\n");

  const timeStr = currentDraft.requestedStart
    ? new Date(currentDraft.requestedStart).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
    : null;

  const itemsSummary = orderDraft.items?.length
    ? orderDraft.items.map(i => `${i.name} x${i.quantity ?? 1}`).join(", ")
    : "none";

  let prompt;

  if (bookingOnly) {
    prompt =
`You are ${agent.agentName || "receptionist"} at ${agent.businessName}. Help customer book a table.

Status: size=${currentDraft.partySize ?? "?"} | time=${timeStr ?? "?"} | name=${currentDraft.customerName ?? "?"}
${recentConvo}
Customer: "${text}"

Ask for the NEXT missing item only. Never mention food, orders, or delivery.

Your reply must be EXACTLY 2 lines with nothing else:
Line 1: your short reply to the customer  (write only the word DONE if all 3 are collected)
Line 2: {"p":<number or null>,"t":"<HH:MM or null>","n":"<string or null>","ot":null,"i":[],"a":null}`;

  } else {
    const ot = orderDraft.orderType;
    const menuLine = agent.menu?.length
      ? `Menu: ${formatMenu(agent.menu)}`
      : "";

    let orderContext;
    if (ot === "pickup") {
      orderContext = `Order: PICKUP. Collect customer name only. Do NOT ask party size, time, or address.`;
    } else if (ot === "delivery") {
      orderContext = `Order: DELIVERY. Collect address then name. Do NOT ask party size or time.`;
    } else if (ot === "dineIn") {
      orderContext = `Order: DINE-IN. Collect items, party size, time, name.`;
    } else {
      orderContext = `Order type unknown. Collect items first, then ask dine-in/pickup/delivery.`;
    }

    const showBooking = !ot || ot === "dineIn";

    prompt =
`You are ${agent.agentName || "receptionist"} at ${agent.businessName}.

${orderContext}
Status: items=${itemsSummary} | type=${ot ?? "?"} | ${showBooking ? `size=${currentDraft.partySize ?? "?"} | time=${timeStr ?? "?"} | ` : ""}name=${currentDraft.customerName ?? "?"} | address=${orderDraft.deliveryAddress ?? "?"}
${menuLine}
${recentConvo}
Customer: "${text}"

Ask for ONE missing item. Only accept menu items. No date, no phone.

Your reply must be EXACTLY 2 lines with nothing else:
Line 1: your short reply to the customer  (write only the word DONE if all required info is collected)
Line 2: {"p":<number or null>,"t":"<HH:MM or null>","n":"<string or null>","ot":"<dineIn|pickup|delivery|null>","i":[{"name":"x","qty":1}],"a":"<address or null>"}`;
  }

  // ── SDK streaming (with non-streaming fallback) ──────────────────────────
  let textContent = "";
  let firstLineFired = false;

  try {
    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 120,
      stream: true,
      messages: [{ role: "user", content: prompt }],
    });

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content ?? "";
      if (!delta) continue;
      textContent += delta;

      // Fire sendChunk as soon as line 1 is complete — don't wait for the rest
      if (!firstLineFired && textContent.includes("\n")) {
        firstLineFired = true;
        const firstLine = textContent.substring(0, textContent.indexOf("\n")).trim();
        const isJson = firstLine.startsWith("{");
        if (firstLine && firstLine !== "DONE" && !isJson && sendChunk) {
          sendChunk(firstLine.replace(/^SPEAK:\s*/i, ""));
        }
      }
    }
  } catch (streamErr) {
    console.error("❌ Streaming failed, falling back to non-streaming:", streamErr.message);
    // Non-streaming fallback — guarantees we always get a response
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: 120,
        messages: [{ role: "user", content: prompt }],
      });
      textContent = completion.choices?.[0]?.message?.content?.trim() ?? "";
      // Still try to send the response line synchronously
      if (sendChunk && textContent) {
        const fallbackFirst = textContent.split("\n")[0]?.trim() ?? "";
        const isJson = fallbackFirst.startsWith("{");
        if (fallbackFirst && fallbackFirst !== "DONE" && !isJson) {
          sendChunk(fallbackFirst.replace(/^SPEAK:\s*/i, ""));
        }
      }
    } catch (fallbackErr) {
      console.error("❌ Fallback also failed:", fallbackErr.message);
    }
  }

  // ── Parse result ─────────────────────────────────────────────────────────
  const parts = textContent.split("\n").map(l => l.trim()).filter(Boolean);
  const firstLine = parts[0] || "";
  // Treat any first line that isn't DONE or JSON as the spoken response
  const isJsonFirst = firstLine.startsWith("{");
  const responseText = (firstLine && firstLine !== "DONE" && !isJsonFirst)
    ? firstLine.replace(/^SPEAK:\s*/i, "").trim()
    : null;
  // JSON is everything after the first non-JSON line, or the whole thing if first line is JSON
  const jsonLine = (isJsonFirst ? parts : parts.slice(1)).join("").trim();

  let extraction = {};
  try {
    extraction = JSON.parse(jsonLine);
  } catch (e) {
    console.error("❌ Extraction parse error:", e.message, "| raw:", jsonLine);
  }

  console.log("🎯 Streamed extraction:", extraction, "| response:", responseText);

  return {
    extracted: {
      partySize: extraction.p ?? null,
      time:      extraction.t ?? null,
      name:      extraction.n ?? null,
    },
    orderExtracted: {
      items:           extraction.i  ?? [],
      orderType:       extraction.ot ?? null,
      deliveryAddress: extraction.a  ?? null,
    },
    response: responseText,
    streamed: !!(responseText && sendChunk),
  };
}

/**
 * ================================
 * IN-MEMORY LOCK (prevents duplicate processing)
 * ================================
 */
const processingCalls = new Set();

/**
 * ================================
 * MAIN CONTROLLER
 * ================================
 */
async function processLLMMessage(body, req, sendChunk = null) {
  console.log("🎯 WEBSOCKET LLM CONTROLLER HIT");

  const interactionType = body.interaction_type || body.type;
  if (interactionType === "ping_pong") return null;
  if (interactionType !== "response_required") return null;

  // ── Call ID ──────────────────────────────────────────────────────────────
  let callId =
    body.call_id || body.callId || body?.metadata?.call_id || null;

  if (!callId && req?.url) {
    const parts = req.url.split("/");
    const last = parts[parts.length - 1];
    if (last?.startsWith("call_")) callId = last;
  }

  if (!callId) {
    console.warn("⚠️ No callId found");
    return { response: "Sorry, something went wrong." };
  }

  // ── Load call (single lean query) ────────────────────────────────────────
  const call = await Call.findOne({
    $or: [{ callId }, { call_id: callId }],
  }).lean();

  if (!call) {
    console.warn("⚠️ Call not found:", callId);
    return { response: "Sorry, something went wrong." };
  }

  // ── Load agent (cached) ───────────────────────────────────────────────────
  const agent = await getCachedAgent(call.agentId);
  if (!agent) {
    console.warn("⚠️ Agent not found for call:", callId);
    return { response: "Sorry, something went wrong." };
  }

  // ── Phone number ──────────────────────────────────────────────────────────
  const phoneFromBody =
    body?.call?.from_number || body?.call?.caller_id ||
    body?.call?.from || body?.call?.customer_number ||
    body?.from_number || null;

  if (!call.callerNumber && phoneFromBody) {
    await Call.updateOne({ _id: call._id }, { $set: { callerNumber: phoneFromBody } });
    call.callerNumber = phoneFromBody;
  }

  // ── User text ─────────────────────────────────────────────────────────────
  const latestUserText =
    typeof body.latest_user_text === "string" ? body.latest_user_text.trim() : "";

  const transcript = body.transcript ?? [];

  // ── Farewell detection ────────────────────────────────────────────────────
  if (looksLikeFarewell(latestUserText)) {
    await Call.updateOne(
      { _id: call._id },
      {
        $set: {
          "bookingDraft.partySize":      null,
          "bookingDraft.requestedStart": null,
          "bookingDraft.customerName":   null,
          "orderDraft.items":            [],
          "orderDraft.orderType":        null,
          "orderDraft.deliveryAddress":  null,
        },
      }
    );
    return { response: "You're welcome! Have a wonderful day. Goodbye!", end_call: true };
  }

  // ── Draft state (from lean call — no second query) ────────────────────────
  let draft = {
    partySize:      call.bookingDraft?.partySize      ?? null,
    requestedStart: call.bookingDraft?.requestedStart ?? null,
    customerName:   call.bookingDraft?.customerName   ?? null,
    customerPhone:  call.bookingDraft?.customerPhone  ?? call.callerNumber ?? phoneFromBody ?? null,
  };

  let orderDraft = {
    items:           call.orderDraft?.items           ?? [],
    orderType:       call.orderDraft?.orderType       ?? null,
    status:          call.orderDraft?.status          ?? null,
    deliveryAddress: call.orderDraft?.deliveryAddress ?? null,
  };

  // ── Intent detection ──────────────────────────────────────────────────────
  const recentText = transcript.slice(-4).map(t => t.content).join(" ");

  const bookingFlowActive =
    !!draft.partySize || !!draft.requestedStart || !!draft.customerName ||
    looksLikeBookingIntent(latestUserText) || looksLikeBookingIntent(recentText);

  const orderFlowActive =
    agent.features?.orders === true && (
      !!orderDraft.items?.length || !!orderDraft.orderType ||
      looksLikeOrderIntent(latestUserText) || looksLikeOrderIntent(recentText)
    );

  // ── Active flow ───────────────────────────────────────────────────────────
  if (bookingFlowActive || orderFlowActive) {

    const { extracted, orderExtracted, response: aiResponse, streamed } =
      await extractAndRespond(latestUserText, draft, orderDraft, transcript, agent, {
        bookingOnly: bookingFlowActive && !orderFlowActive,
        sendChunk,
      });

    console.log("🧠 Extracted:", extracted);
    console.log("🛒 Order extracted:", orderExtracted);

    // Merge extracted booking fields
    if (extracted.partySize && !draft.partySize) draft.partySize = extracted.partySize;
    if (extracted.time && !draft.requestedStart) {
      try {
        const [h, m] = extracted.time.split(":").map(Number);
        const d = new Date();
        d.setHours(h, m || 0, 0, 0);
        draft.requestedStart = d;
      } catch (e) {
        console.error("❌ Time parse error:", e);
      }
    }
    if (extracted.name && !draft.customerName) draft.customerName = extracted.name;

    // Merge extracted order fields
    if (orderExtracted.items?.length > 0) {
      const validItems = orderExtracted.items.filter(item =>
        agent.menu?.some(m => m.name.toLowerCase() === item.name.toLowerCase() && m.available)
      );
      for (const newItem of validItems) {
        const exists = orderDraft.items.some(
          e => e.name.toLowerCase() === newItem.name.toLowerCase()
        );
        if (!exists) orderDraft.items.push(newItem);
      }
    }
    if (orderExtracted.orderType) orderDraft.orderType = orderExtracted.orderType;
    if (orderExtracted.deliveryAddress) orderDraft.deliveryAddress = orderExtracted.deliveryAddress;

    // Persist drafts (fire-and-forget — don't block on this)
    Call.updateOne(
      { _id: call._id },
      {
        $set: {
          "bookingDraft.partySize":      draft.partySize,
          "bookingDraft.requestedStart": draft.requestedStart,
          "bookingDraft.customerName":   draft.customerName,
          "bookingDraft.customerPhone":  draft.customerPhone,
          "orderDraft.items":            orderDraft.items,
          "orderDraft.orderType":        orderDraft.orderType,
          "orderDraft.status":           orderDraft.status,
          "orderDraft.deliveryAddress":  orderDraft.deliveryAddress,
        },
      }
    ).catch(err => console.error("❌ Draft save error:", err.message));

    console.log("📋 Draft:", draft);
    console.log("🛒 Order draft:", orderDraft);

    // If AI produced a response (streamed or not), return it
    if (aiResponse || streamed) {
      return { response: streamed ? null : aiResponse, streamed, end_call: false };
    }

    /**
     * DINE-IN ORDER → SAVE ORDER + BOOKING
     */
    if (
      orderFlowActive &&
      orderDraft.orderType === "dineIn" &&
      orderDraft.items?.length > 0 &&
      draft.partySize && draft.requestedStart && draft.customerName
    ) {
      if (processingCalls.has(callId)) return { response: "One moment please..." };
      processingCalls.add(callId);

      try {
        const existingOrder = await Order.findOne({ callId });
        if (existingOrder) {
          await clearDrafts(call._id);
          return { response: `Your order and table are already confirmed under ${draft.customerName}. Is there anything else I can help you with?` };
        }

        const result = await findNearestAvailableSlot({
          businessId: agent.businessId, requestedStart: draft.requestedStart,
          durationMinutes: 90, partySize: draft.partySize,
          source: "ai", agentId: agent._id, callId,
          customerName: draft.customerName, customerPhone: draft.customerPhone,
        });

        if (result?.success && result.booking) {
          const total = calcTotal(orderDraft.items, agent.menu);
          await Order.create({
            callId, businessId: agent.businessId, agentId: agent._id,
            customerName: draft.customerName, customerPhone: draft.customerPhone || call.callerNumber,
            items: buildOrderItems(orderDraft.items, agent.menu),
            orderType: "dineIn", total, status: "confirmed",
          });
          await clearDrafts(call._id, true);

          const timeStr = new Date(result.booking.startIso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
          const summary = orderDraft.items.map(i => `${i.name} x${i.quantity || 1}`).join(", ");
          return { response: `Perfect! Table for ${draft.partySize} at ${timeStr} under ${draft.customerName}. Your ${summary} will be ready. Total ${total} AED. Anything else?` };
        }

        if (result?.suggestedTime) {
          const sug = new Date(result.suggestedTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
          return { response: `We're fully booked at that time. Would ${sug} work instead?` };
        }

        return { response: "Sorry, no availability at that time. Want to try a different time?" };

      } catch (err) {
        console.error("❌ Dine-in error:", err.message);
        return { response: "Sorry, something went wrong. Please try again." };
      } finally {
        processingCalls.delete(callId);
      }
    }

    /**
     * BOOKING ONLY
     */
    if (
      bookingFlowActive && !orderFlowActive &&
      draft.partySize && draft.requestedStart && draft.customerName
    ) {
      const existingBooking = await Booking.findOne({ callId, status: { $in: ["confirmed", "seated"] } });
      if (existingBooking) {
        await clearBookingDraft(call._id);
        return { response: `Your reservation is already confirmed under ${draft.customerName}. Is there anything else?` };
      }

      if (processingCalls.has(callId)) return { response: "One moment please..." };
      processingCalls.add(callId);

      try {
        const result = await findNearestAvailableSlot({
          businessId: agent.businessId, requestedStart: draft.requestedStart,
          durationMinutes: 90, partySize: draft.partySize,
          source: "ai", agentId: agent._id, callId,
          customerName: draft.customerName, customerPhone: draft.customerPhone,
        });

        if (result?.success && result.booking) {
          await clearBookingDraft(call._id);
          const timeStr = new Date(result.booking.startIso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
          return { response: `Perfect! Table for ${draft.partySize} confirmed at ${timeStr} under ${draft.customerName}. Is there anything else?` };
        }

        if (result?.suggestedTime) {
          const sug = new Date(result.suggestedTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
          return { response: `We're fully booked then. Would ${sug} work instead?` };
        }

        return { response: "No availability at that time. Want to try a different time?" };

      } catch (err) {
        console.error("❌ Booking error:", err.message);
        return { response: "Sorry, something went wrong. Please try again." };
      } finally {
        processingCalls.delete(callId);
      }
    }

    /**
     * PICKUP OR DELIVERY ORDER
     */
    if (
      orderFlowActive &&
      orderDraft.items?.length > 0 &&
      orderDraft.orderType &&
      orderDraft.orderType !== "dineIn"
    ) {
      if (orderDraft.orderType === "delivery") {
        if (!orderDraft.deliveryAddress) return { response: "What is your delivery address?" };
        if (!draft.customerName) return { response: "And what name should I put the order under?" };
      }
      if (orderDraft.orderType === "pickup" && !draft.customerName) {
        return { response: "What name should I put the order under?" };
      }

      const existingOrder = await Order.findOne({ callId });
      if (existingOrder) {
        await clearOrderDraft(call._id);
        return { response: `Your order is already placed under ${draft.customerName || "your name"}. Is there anything else?` };
      }

      const total = calcTotal(orderDraft.items, agent.menu);
      await Order.create({
        callId, businessId: agent.businessId, agentId: agent._id,
        customerName: draft.customerName || "Guest",
        customerPhone: draft.customerPhone || call.callerNumber,
        deliveryAddress: orderDraft.deliveryAddress || null,
        items: buildOrderItems(orderDraft.items, agent.menu),
        orderType: orderDraft.orderType, total, status: "confirmed",
      });

      await clearOrderDraft(call._id);

      console.log("✅ Order saved:", orderDraft.orderType);
      const summary = orderDraft.items.map(i => `${i.name} x${i.quantity || 1}`).join(", ");

      const confirmMsg = orderDraft.orderType === "delivery"
        ? `Perfect! ${summary} will be delivered to ${orderDraft.deliveryAddress} under ${draft.customerName}. Total ${total} AED. Anything else?`
        : `Perfect! ${summary} ready for pickup under ${draft.customerName}. Total ${total} AED. Anything else?`;

      return { response: confirmMsg };
    }

    return { response: aiResponse || "How can I help you?" };
  }

  /**
   * GENERAL FALLBACK — stream AI response
   */
  const systemPrompt = buildSystemPrompt(agent);
  const conversationHistory = transcript.slice(-4).map(t => ({
    role: t.role === "agent" ? "assistant" : "user",
    content: t.content,
  }));

  const messages = [
    { role: "system", content: systemPrompt },
    ...conversationHistory,
    { role: "user", content: latestUserText || "Hello" },
  ];

  if (sendChunk) {
    const text = await streamAIResponse(messages, sendChunk);
    return { streamed: !!text, end_call: false };
  }

  // Non-streaming fallback (should rarely reach here)
  const { getAIResponse } = require("../services/aiChatService");
  const aiReply = await getAIResponse(messages);
  return { response: aiReply || "How can I help you today?" };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function calcTotal(items, menu) {
  return items.reduce((sum, item) => {
    const m = menu?.find(m => m.name.toLowerCase() === item.name.toLowerCase());
    return sum + (m?.price || 0) * (item.quantity || item.qty || 1);
  }, 0);
}

function buildOrderItems(items, menu) {
  return items.map(item => {
    const m = menu?.find(m => m.name.toLowerCase() === item.name.toLowerCase());
    return {
      name:     item.name,
      quantity: item.quantity || item.qty || 1,
      price:    m?.price || 0,
      extras:   item.extras || [],
    };
  });
}

async function clearBookingDraft(callId) {
  return Call.updateOne(
    { _id: callId },
    { $set: { "bookingDraft.partySize": null, "bookingDraft.requestedStart": null, "bookingDraft.customerName": null } }
  );
}

async function clearOrderDraft(callId) {
  return Call.updateOne(
    { _id: callId },
    { $set: { "orderDraft.items": [], "orderDraft.orderType": null, "orderDraft.deliveryAddress": null } }
  );
}

async function clearDrafts(callId, includeOrder = false) {
  const $set = {
    "bookingDraft.partySize": null, "bookingDraft.requestedStart": null, "bookingDraft.customerName": null,
  };
  if (includeOrder) {
    $set["orderDraft.items"] = [];
    $set["orderDraft.orderType"] = null;
    $set["orderDraft.deliveryAddress"] = null;
  }
  return Call.updateOne({ _id: callId }, { $set });
}

module.exports = { processLLMMessage };
