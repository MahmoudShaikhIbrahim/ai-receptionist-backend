// src/controllers/llmSocketController.js

const OpenAI  = require("openai");
const Agent   = require("../models/Agent");
const Call    = require("../models/Call");
const Booking = require("../models/Booking");
const Order   = require("../models/Order");
const { getAIResponse } = require("../services/aiChatService");
const { findNearestAvailableSlot } = require("../services/bookingService");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─────────────────────────────────────────────────────────────────────────────
// Agent cache — avoids a DB round-trip on every message
// ─────────────────────────────────────────────────────────────────────────────
const agentCache = new Map();
const AGENT_TTL  = 5 * 60 * 1000; // 5 min

async function getCachedAgent(agentId) {
  const key    = agentId.toString();
  const cached = agentCache.get(key);
  if (cached && Date.now() - cached.ts < AGENT_TTL) return cached.agent;
  const agent = await Agent.findById(agentId).lean();
  if (agent) agentCache.set(key, { agent, ts: Date.now() });
  return agent;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function formatMenu(menu) {
  if (!menu?.length) return "No menu available.";
  return menu
    .filter(i => i.available)
    .map(i => `${i.name}: ${i.price} ${i.currency || "AED"}`)
    .join(", ");
}

function formatHours(openingHours) {
  if (!openingHours) return "Hours not set.";
  const days = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];
  return days.map(d => {
    const h = openingHours[d];
    if (!h || h.closed)          return `${d}: Closed`;
    if (!h.open && !h.close)     return `${d}: Not set`;
    return `${d}: ${h.open}-${h.close}`;
  }).join(", ");
}

function timeStr(date) {
  if (!date) return null;
  return new Date(date).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function calcTotal(items, menu) {
  return items.reduce((sum, item) => {
    const m = menu?.find(m => m.name.toLowerCase() === item.name.toLowerCase());
    return sum + (m?.price || 0) * (item.quantity || 1);
  }, 0);
}

function buildOrderItems(items, menu) {
  return items.map(item => {
    const m = menu?.find(m => m.name.toLowerCase() === item.name.toLowerCase());
    return { name: item.name, quantity: item.quantity || 1, price: m?.price || 0, extras: item.extras || [] };
  });
}

async function clearBookingDraft(callId) {
  await Call.updateOne({ _id: callId }, {
    $set: { "bookingDraft.partySize": null, "bookingDraft.requestedStart": null, "bookingDraft.customerName": null },
  });
}

async function clearOrderDraft(callId) {
  await Call.updateOne({ _id: callId }, {
    $set: { "orderDraft.items": [], "orderDraft.orderType": null, "orderDraft.deliveryAddress": null },
  });
}

async function clearAllDrafts(callId) {
  await Call.updateOne({ _id: callId }, {
    $set: {
      "bookingDraft.partySize": null, "bookingDraft.requestedStart": null, "bookingDraft.customerName": null,
      "orderDraft.items": [], "orderDraft.orderType": null, "orderDraft.deliveryAddress": null,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Intent detection
// ─────────────────────────────────────────────────────────────────────────────
function isBookingIntent(text) {
  return /\b(book|reserve|reservation|table)\b/i.test(text || "");
}

function isOrderIntent(text) {
  return /\b(order|food|eat|hungry|menu|delivery|pickup|take.?away|bring|want to eat)\b/i.test(text || "");
}

function isFarewell(text) {
  return /\b(bye|goodbye|good night|see you|gotta go|that.?s all|nothing else|all good|have a good)\b/i.test(text || "");
}

// ─────────────────────────────────────────────────────────────────────────────
// AI extraction
//
// Asks GPT-4o-mini to:
//   1. Extract structured data (partySize, time, name, orderType, items, address)
//   2. Generate the next conversational reply
//
// Returns { partySize, requestedTime, customerName, orderType, items,
//           deliveryAddress, response }
// ─────────────────────────────────────────────────────────────────────────────
async function aiExtract(userText, draft, orderDraft, transcript, agent, bookingOnly) {
  const recent = (transcript || [])
    .slice(-4)
    .map(t => `${t.role === "agent" ? "Agent" : "Customer"}: ${t.content}`)
    .join("\n");

  const itemsStr = orderDraft.items?.length
    ? orderDraft.items.map(i => `${i.name} x${i.quantity || 1}`).join(", ")
    : "none";

  let prompt;

  if (bookingOnly) {
    // ── Booking-only prompt ─────────────────────────────────────────────────
    prompt = `You are ${agent.agentName || "a receptionist"} at ${agent.businessName}.
The customer wants to BOOK A TABLE. Do NOT ask about food, orders, pickup, or delivery.

What has been collected:
- Party size: ${draft.partySize ?? "not yet"}
- Time: ${timeStr(draft.requestedStart) ?? "not yet"}
- Customer name: ${draft.customerName ?? "not yet"}

Recent conversation:
${recent}

Customer just said: "${userText}"

Your task:
1. Extract any of: party size (number), time (as HH:MM 24h), customer name
2. Ask for the next missing piece — party size first, then time, then name
3. If all three are collected, set response to null

Reply with this JSON only (no markdown, no extra text):
{"partySize":null,"requestedTime":null,"customerName":null,"orderType":null,"items":[],"deliveryAddress":null,"response":"your reply here or null"}`;

  } else {
    // ── Order / combined prompt ─────────────────────────────────────────────
    const ot = orderDraft.orderType;
    const menu = agent.menu?.length ? `Available menu: ${formatMenu(agent.menu)}` : "";

    let rules;
    if (ot === "pickup") {
      rules = "This is a PICKUP order. Collect customer name only. Do NOT ask for party size, time, or address.";
    } else if (ot === "delivery") {
      rules = "This is a DELIVERY order. Collect delivery address and customer name. Do NOT ask for party size or time.";
    } else if (ot === "dineIn") {
      rules = "This is a DINE-IN order. Collect items, party size, time, and customer name.";
    } else {
      rules = "Order type not yet known. Collect items first, then ask if it's for dine-in, pickup, or delivery.";
    }

    const bookingFields = (!ot || ot === "dineIn")
      ? `- Party size: ${draft.partySize ?? "not yet"}\n- Time: ${timeStr(draft.requestedStart) ?? "not yet"}`
      : "";

    prompt = `You are ${agent.agentName || "a receptionist"} at ${agent.businessName}.
${rules}

What has been collected:
- Items: ${itemsStr}
- Order type: ${ot ?? "not yet"}
${bookingFields}
- Customer name: ${draft.customerName ?? "not yet"}
- Delivery address: ${orderDraft.deliveryAddress ?? "not yet"}

${menu}

Recent conversation:
${recent}

Customer just said: "${userText}"

Your task:
1. Extract any info from what the customer said (items must match the menu exactly)
2. Ask for the next missing piece — one question at a time
3. If all required info is collected, set response to null

Reply with this JSON only (no markdown, no extra text):
{"partySize":null,"requestedTime":null,"customerName":null,"orderType":null,"items":[{"name":"item name","quantity":1}],"deliveryAddress":null,"response":"your reply here or null"}`;
  }

  // ── Call OpenAI ───────────────────────────────────────────────────────────
  let raw = "";
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 150,
      temperature: 0.3,
      messages: [{ role: "user", content: prompt }],
    });
    raw = completion.choices?.[0]?.message?.content?.trim() ?? "";
  } catch (err) {
    console.error("❌ OpenAI error:", err.message);
    return { response: "I'm sorry, could you repeat that?" };
  }

  // ── Parse JSON ────────────────────────────────────────────────────────────
  let parsed = {};
  try {
    const clean = raw.replace(/```json|```/g, "").trim();
    parsed = JSON.parse(clean);
  } catch {
    console.error("❌ JSON parse error. Raw:", raw);
    // If parsing fails, try to return the raw text as the response
    return { response: raw.length < 200 ? raw : "Could you say that again?" };
  }

  console.log("🤖 AI extracted:", parsed);
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// System prompt for general fallback
// ─────────────────────────────────────────────────────────────────────────────
function buildSystemPrompt(agent) {
  const features = [];
  if (agent.features?.bookings !== false) features.push("table reservations");
  if (agent.features?.orders === true && agent.features?.dineIn !== false) features.push("dine-in orders");
  if (agent.features?.orders === true && agent.features?.pickup === true) features.push("pickup orders");
  if (agent.features?.orders === true && agent.features?.delivery === true) features.push("delivery orders");

  const base = agent.agentPrompt?.trim()
    || `You are ${agent.agentName || "an AI receptionist"} at ${agent.businessName}. You are friendly and helpful.`;

  return `${base}
Services offered: ${features.join(", ") || "general inquiries"}.
Hours: ${formatHours(agent.openingHours)}
Rules: The customer has already been greeted — do NOT say hello again. Keep replies very short (1-2 sentences). Never ask for a phone number.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Duplicate-processing lock
// ─────────────────────────────────────────────────────────────────────────────
const processingCalls = new Set();

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────
async function processLLMMessage(body, req) {
  console.log("🎯 LLM message received");

  const interactionType = body.interaction_type || body.type;
  if (interactionType === "ping_pong" || interactionType !== "response_required") return null;

  // ── Resolve call ID ───────────────────────────────────────────────────────
  let callId = body.call_id || body.callId || body?.metadata?.call_id || null;
  if (!callId && req?.url) {
    const last = req.url.split("/").pop();
    if (last?.startsWith("call_")) callId = last;
  }
  if (!callId) return { response: "Sorry, something went wrong." };

  // ── Load call (single query) ──────────────────────────────────────────────
  const call = await Call.findOne({ $or: [{ callId }, { call_id: callId }] }).lean();
  if (!call) return { response: "Sorry, something went wrong." };

  // ── Load agent (cached) ───────────────────────────────────────────────────
  const agent = await getCachedAgent(call.agentId);
  if (!agent) return { response: "Sorry, something went wrong." };

  // ── Phone number ──────────────────────────────────────────────────────────
  const phone =
    body?.call?.from_number || body?.call?.caller_id || body?.call?.from ||
    body?.call?.customer_number || body?.from_number || null;

  if (!call.callerNumber && phone) {
    Call.updateOne({ _id: call._id }, { $set: { callerNumber: phone } }).catch(() => {});
    call.callerNumber = phone;
  }

  // ── User text ─────────────────────────────────────────────────────────────
  const userText  = typeof body.latest_user_text === "string" ? body.latest_user_text.trim() : "";
  const transcript = body.transcript ?? [];

  // ── Farewell ──────────────────────────────────────────────────────────────
  if (isFarewell(userText)) {
    clearAllDrafts(call._id).catch(() => {});
    return { response: "You're welcome! Have a wonderful day. Goodbye!", end_call: true };
  }

  // ── Build draft state ─────────────────────────────────────────────────────
  let draft = {
    partySize:      call.bookingDraft?.partySize      ?? null,
    requestedStart: call.bookingDraft?.requestedStart ?? null,
    customerName:   call.bookingDraft?.customerName   ?? null,
    customerPhone:  call.bookingDraft?.customerPhone  ?? call.callerNumber ?? phone ?? null,
  };

  let orderDraft = {
    items:           call.orderDraft?.items           ?? [],
    orderType:       call.orderDraft?.orderType       ?? null,
    deliveryAddress: call.orderDraft?.deliveryAddress ?? null,
  };

  // ── Intent detection ──────────────────────────────────────────────────────
  const recentText = transcript.slice(-4).map(t => t.content).join(" ");

  const bookingActive =
    !!draft.partySize || !!draft.requestedStart || !!draft.customerName ||
    isBookingIntent(userText) || isBookingIntent(recentText);

  const orderActive =
    agent.features?.orders === true && (
      !!orderDraft.items?.length || !!orderDraft.orderType ||
      isOrderIntent(userText)   || isOrderIntent(recentText)
    );

  // ── Active booking / order flow ───────────────────────────────────────────
  if (bookingActive || orderActive) {

    const extracted = await aiExtract(
      userText, draft, orderDraft, transcript, agent,
      bookingActive && !orderActive   // bookingOnly flag
    );

    // Merge extracted booking fields
    if (extracted.partySize  && !draft.partySize)      draft.partySize = extracted.partySize;
    if (extracted.customerName && !draft.customerName) draft.customerName = extracted.customerName;
    if (extracted.requestedTime && !draft.requestedStart) {
      try {
        const [h, m] = extracted.requestedTime.split(":").map(Number);
        const d = new Date();
        d.setHours(h, m || 0, 0, 0);
        draft.requestedStart = d;
      } catch { /* ignore bad time format */ }
    }

    // Merge extracted order fields
    if (extracted.orderType)       orderDraft.orderType       = extracted.orderType;
    if (extracted.deliveryAddress) orderDraft.deliveryAddress = extracted.deliveryAddress;
    if (extracted.items?.length > 0) {
      const valid = extracted.items.filter(item =>
        agent.menu?.some(m => m.name.toLowerCase() === item.name.toLowerCase() && m.available)
      );
      for (const newItem of valid) {
        if (!orderDraft.items.some(e => e.name.toLowerCase() === newItem.name.toLowerCase())) {
          orderDraft.items.push(newItem);
        }
      }
    }

    // Persist drafts (non-blocking)
    Call.updateOne({ _id: call._id }, {
      $set: {
        "bookingDraft.partySize":      draft.partySize,
        "bookingDraft.requestedStart": draft.requestedStart,
        "bookingDraft.customerName":   draft.customerName,
        "bookingDraft.customerPhone":  draft.customerPhone,
        "orderDraft.items":            orderDraft.items,
        "orderDraft.orderType":        orderDraft.orderType,
        "orderDraft.deliveryAddress":  orderDraft.deliveryAddress,
      },
    }).catch(() => {});

    console.log("📋 Draft:", draft);
    console.log("🛒 Order draft:", orderDraft);

    // If AI has a conversational response, return it now
    if (extracted.response) {
      return { response: extracted.response };
    }

    // ── All info collected — attempt to confirm ──────────────────────────

    // DINE-IN: order + booking
    if (
      orderActive && orderDraft.orderType === "dineIn" &&
      orderDraft.items?.length && draft.partySize && draft.requestedStart && draft.customerName
    ) {
      if (processingCalls.has(callId)) return { response: "One moment please..." };
      processingCalls.add(callId);
      try {
        const existing = await Order.findOne({ callId });
        if (existing) {
          await clearAllDrafts(call._id);
          return { response: `Your order and table are already confirmed under ${draft.customerName}. Anything else?` };
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
          await clearAllDrafts(call._id);
          const t = timeStr(result.booking.startIso);
          const summary = orderDraft.items.map(i => `${i.name} x${i.quantity || 1}`).join(", ");
          return { response: `Perfect! Table for ${draft.partySize} at ${t} under ${draft.customerName}. Your ${summary} will be ready when you arrive. Total: ${total} AED. Anything else?` };
        }

        if (result?.suggestedTime) {
          return { response: `We're fully booked then. Would ${timeStr(result.suggestedTime)} work instead?` };
        }
        return { response: "No availability at that time. Want to try a different time?" };

      } catch (err) {
        console.error("❌ Dine-in error:", err.message);
        return { response: "Sorry, something went wrong. Please try again." };
      } finally {
        processingCalls.delete(callId);
      }
    }

    // BOOKING ONLY
    if (
      bookingActive && !orderActive &&
      draft.partySize && draft.requestedStart && draft.customerName
    ) {
      if (processingCalls.has(callId)) return { response: "One moment please..." };
      processingCalls.add(callId);
      try {
        const existing = await Booking.findOne({ callId, status: { $in: ["confirmed","seated"] } });
        if (existing) {
          await clearBookingDraft(call._id);
          return { response: `Your reservation is already confirmed under ${draft.customerName}. Anything else?` };
        }

        const result = await findNearestAvailableSlot({
          businessId: agent.businessId, requestedStart: draft.requestedStart,
          durationMinutes: 90, partySize: draft.partySize,
          source: "ai", agentId: agent._id, callId,
          customerName: draft.customerName, customerPhone: draft.customerPhone,
        });

        if (result?.success && result.booking) {
          await clearBookingDraft(call._id);
          return { response: `Perfect! Table for ${draft.partySize} confirmed at ${timeStr(result.booking.startIso)} under ${draft.customerName}. Anything else?` };
        }

        if (result?.suggestedTime) {
          return { response: `We're fully booked then. Would ${timeStr(result.suggestedTime)} work instead?` };
        }
        return { response: "No availability at that time. Want to try a different time?" };

      } catch (err) {
        console.error("❌ Booking error:", err.message);
        return { response: "Sorry, something went wrong. Please try again." };
      } finally {
        processingCalls.delete(callId);
      }
    }

    // PICKUP or DELIVERY
    if (
      orderActive && orderDraft.items?.length &&
      orderDraft.orderType && orderDraft.orderType !== "dineIn"
    ) {
      if (orderDraft.orderType === "delivery") {
        if (!orderDraft.deliveryAddress) return { response: "What is your delivery address?" };
        if (!draft.customerName)         return { response: "What name should I put the order under?" };
      }
      if (orderDraft.orderType === "pickup" && !draft.customerName) {
        return { response: "What name should I put the order under?" };
      }

      const existing = await Order.findOne({ callId });
      if (existing) {
        await clearOrderDraft(call._id);
        return { response: `Your order is already placed under ${draft.customerName || "your name"}. Anything else?` };
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

      const summary = orderDraft.items.map(i => `${i.name} x${i.quantity || 1}`).join(", ");
      if (orderDraft.orderType === "delivery") {
        return { response: `Perfect! ${summary} will be delivered to ${orderDraft.deliveryAddress} under ${draft.customerName}. Total: ${total} AED. Anything else?` };
      }
      return { response: `Perfect! ${summary} ready for pickup under ${draft.customerName}. Total: ${total} AED. Anything else?` };
    }

    // Shouldn't reach here, but just in case
    return { response: "How can I help you?" };
  }

  // ── General fallback ──────────────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt(agent);
  const history = transcript.slice(-6).map(t => ({
    role: t.role === "agent" ? "assistant" : "user",
    content: t.content,
  }));

  const reply = await getAIResponse([
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userText || "Hello" },
  ]);

  return { response: reply || "How can I help you today?" };
}

module.exports = { processLLMMessage };
