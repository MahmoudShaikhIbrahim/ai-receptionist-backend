// src/controllers/llmSocketController.js

const Agent = require("../models/Agent");
const Call = require("../models/Call");
const Booking = require("../models/Booking");
const Order = require("../models/Order");
const { getAIResponse } = require("../services/aiChatService");
const { findNearestAvailableSlot } = require("../services/bookingService");

// ─── PER-CALL PROCESSING LOCK ─────────────────────────────────────────────────
// Prevents duplicate processing when Retell sends multiple rapid requests
const activeCallProcessing = new Map(); // callId -> timestamp

function acquireLock(callId) {
  const now = Date.now();
  const last = activeCallProcessing.get(callId);
  if (last && now - last < 1000) return false; // locked for 1100ms
  activeCallProcessing.set(callId, now);
  return true;
}

function releaseLock(callId) {
  activeCallProcessing.delete(callId);
}

// Clean up old locks every 30 seconds
setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of activeCallProcessing.entries()) {
    if (now - ts > 10000) activeCallProcessing.delete(id);
  }
}, 30000);

// ─── HELPERS ────────────────────────────────────────────────────────────────

function formatMenu(menu) {
  if (!menu || menu.length === 0) return "No menu available.";
  const categories = {};
  for (const item of menu) {
    if (!item.available) continue;
    const cat = item.category || "General";
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(item);
  }
  return Object.entries(categories)
    .map(([cat, items]) => {
      const lines = items.map(i => {
        let line = `  - ${i.name}: ${i.price} ${i.currency || "AED"}`;
        if (i.description) line += ` — ${i.description}`;
        if (i.extras?.length) line += ` (Extras: ${i.extras.map(e => `${e.name} +${e.price}`).join(", ")})`;
        return line;
      });
      return `${cat}:\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

function formatOpeningHours(openingHours) {
  if (!openingHours) return "Opening hours not set.";
  const days = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];
  return days.map(day => {
    const h = openingHours[day];
    if (!h || h.closed) return `${day.charAt(0).toUpperCase() + day.slice(1)}: Closed`;
    if (!h.open && !h.close) return `${day.charAt(0).toUpperCase() + day.slice(1)}: Hours not set`;
    return `${day.charAt(0).toUpperCase() + day.slice(1)}: ${h.open} - ${h.close}`;
  }).join("\n");
}

function buildSystemPrompt(agent) {
  const hasBookings = agent.features?.bookings !== false;
  const hasOrders = agent.features?.orders === true;
  const hasDelivery = agent.features?.delivery === true;
  const hasPickup = agent.features?.pickup === true;
  const hasDineIn = agent.features?.dineIn !== false;

  const features = [];
  if (hasBookings) features.push("table reservations");
  if (hasOrders && hasDineIn) features.push("dine-in orders");
  if (hasOrders && hasPickup) features.push("pickup orders");
  if (hasOrders && hasDelivery) features.push("delivery orders");

  const basePrompt = agent.agentPrompt?.trim()
    ? agent.agentPrompt
    : `You are ${agent.agentName || "an AI receptionist"} at ${agent.businessName}. You are friendly, professional, and helpful.`;

  return `${basePrompt}

You can help customers with: ${features.join(", ") || "general inquiries"}.

Opening Hours:
${formatOpeningHours(agent.openingHours)}

${hasOrders && agent.menu?.length > 0 ? `Menu:\n${formatMenu(agent.menu)}` : ""}

Rules:
- Keep responses short and natural, suitable for a phone call
- Never ask for the customer's phone number
- Never mention dates for reservations, only times
- NEVER suggest ordering or ask if customer wants to order after a booking is confirmed
- NEVER ask "party size" — say "how many people" instead
- If asked about something not on the menu, politely say it is not available
- Always be warm and welcoming`;
}

// ─── EXTRACTION ──────────────────────────────────────────────────────────────

async function extractAndRespond(text, currentDraft, orderDraft, transcript, agent, returningContext) {
  if (!text?.trim()) return { extracted: {}, orderExtracted: {}, response: null, intent: null };

  const hasOrders = agent.features?.orders === true;
  const hasBookings = agent.features?.bookings !== false;

  const recentConvo = (transcript ?? [])
    .slice(-4)
    .map(t => `${t.role === "agent" ? "Agent" : "Customer"}: ${t.content}`)
    .join("\n");

  const menuText = hasOrders && agent.menu?.length > 0
    ? `Available menu:\n${formatMenu(agent.menu)}`
    : "";

  const returningInfo = returningContext ? `Returning customer context: ${returningContext}` : "";

  const prompt = `You are a receptionist at ${agent.businessName}.

Current state:
- Booking: people=${currentDraft.partySize ?? "not collected"}, time=${currentDraft.requestedStart ? new Date(currentDraft.requestedStart).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:true}) : "not collected"}, name=${currentDraft.customerName ?? "not collected"}
- Order: items=${orderDraft.items?.length > 0 ? orderDraft.items.map(i=>`${i.name}x${i.quantity}`).join(",") : "none"}, type=${orderDraft.orderType ?? "not set"}, address=${orderDraft.deliveryAddress ?? "not collected"}
${returningInfo}

${menuText}

Recent conversation:
${recentConvo}

Customer just said: "${text}"

STRICT RULES:
- If customer mentions the order type in their message (e.g. "order for dine in", "pickup order", "delivery order"), extract it immediately. ONLY ask "Would you like delivery, pickup, or dine-in?" if the customer did NOT mention the order type.
- NEVER set orderType to dineIn just because customer wants to book a table. orderType dineIn is ONLY when customer explicitly orders food to eat inside. Booking a table is NOT an order.
- If customer says "book a table" or "reserve a table" with no food items, leave orderType as null.
- For pickup: collect items first, then time, then name. NEVER ask address or party size.
- For delivery: collect items first, then address, then name. NEVER ask party size.
- For dineIn: collect items, how many people, time, and name. NEVER assume partySize from the quantity of food items ordered. Always ask separately how many people will be dining.
- NEVER say "party size" — say "how many people" instead.
- Never ask for phone number or date.
- Keep responses short and warm.
- If customer corrects their name, use the corrected name.
- For delivery address: extract ONLY meaningful location info. Remove filler words like "uh", "um", "it's in", "the building name is". Only include parts customer actually mentioned. Never include "null" in address.
- If customer wants to CANCEL booking or order, set intent to "cancel".
- If customer wants to MODIFY booking or order, set intent to "modify".
- If all required info collected, return null for response.

Respond ONLY with valid JSON (no markdown):
{
  "extracted": {"partySize": <number or null>, "time": "<HH:MM 24hr or null>", "name": "<string or null>"},
  "orderExtracted": {"items": [{"name": "<exact menu item name>", "quantity": <number>, "extras": []}], "orderType": "<dineIn|pickup|delivery|null>", "deliveryAddress": "<cleaned address or null>"},
  "intent": "<cancel|modify|new|null>",
  "response": "<your reply or null>"
}`;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 200,
        temperature: 0.3,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content?.trim() ?? "{}";
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    console.log("🎯 Extraction:", parsed);
    return {
      extracted: parsed.extracted ?? {},
      orderExtracted: parsed.orderExtracted ?? {},
      intent: parsed.intent ?? null,
      response: parsed.response ?? null,
    };
  } catch (err) {
    console.error("❌ OpenAI error:", err.message);
    return { extracted: {}, orderExtracted: {}, response: null, intent: null };
  }
}

// ─── INTENT DETECTION ────────────────────────────────────────────────────────

function looksLikeBookingIntent(text) {
  if (!text) return false;
  return /\b(book|reserve|reservation|table)\b/i.test(text);
}

function looksLikeOrderIntent(text) {
  if (!text) return false;
  return /\b(order|food|eat|hungry|menu|delivery|pickup|take.?away|bring|want to eat)\b/i.test(text);
}

function looksLikeCancelIntent(text) {
  if (!text) return false;
  return /\b(cancel|cancellation|delete|remove|forget|drop|never mind|nevermind)\b/i.test(text);
}

function looksLikeModifyIntent(text) {
  if (!text) return false;
  return /\b(change|modify|update|edit|make it|instead|switch|different|wrong|correct|fix)\b/i.test(text);
}

// ─── BOOKING ENGINE LOCK ──────────────────────────────────────────────────────
const processingCalls = new Set();

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function processLLMMessage(body, req) {
  console.log("🎯 WEBSOCKET LLM CONTROLLER HIT");

  const interactionType = body.interaction_type || body.type;
  if (interactionType === "ping_pong") return null;
  if (interactionType !== "response_required") return null;

  // ── CALL ID ──────────────────────────────────────────────
  let callId = body.call_id || body.callId || body?.metadata?.call_id || null;
  if (!callId && req?.url) {
    const parts = req.url.split("/");
    const last = parts[parts.length - 1];
    if (last?.startsWith("call_")) callId = last;
  }
  if (!callId) return { response: "Sorry, something went wrong." };

  // ── PER-CALL LOCK — prevent duplicate processing ─────────
  if (!acquireLock(callId)) {
    console.log(`⏭ Skipping duplicate request for call: ${callId}`);
    return null;
  }

  try {
    return await _processMessage(body, req, callId);
  } finally {
    releaseLock(callId);
  }
}

async function _processMessage(body, req, callId) {

  // ── LOAD CALL ────────────────────────────────────────────
  const freshCall = await Call.findOne({
    $or: [{ callId }, { call_id: callId }],
  }).lean();
  if (!freshCall) return { response: "Sorry, something went wrong." };

  // ── LOAD AGENT ───────────────────────────────────────────
  const agent = await Agent.findById(freshCall.agentId).lean();
  if (!agent) return { response: "Sorry, something went wrong." };

  // ── PHONE NUMBER ─────────────────────────────────────────
  const phoneFromBody =
    body?.call?.from_number || body?.call?.caller_id ||
    body?.call?.from || body?.call?.customer_number || body?.from_number || null;

  const callerPhone = freshCall.callerNumber || phoneFromBody || null;

  if (!freshCall.callerNumber && phoneFromBody) {
    await Call.updateOne({ _id: freshCall._id }, { $set: { callerNumber: phoneFromBody } });
  }

  // ── USER TEXT ────────────────────────────────────────────
  const latestUserText = typeof body.latest_user_text === "string"
    ? body.latest_user_text.trim() : "";
  const transcript = body.transcript ?? [];
  console.log(`🗣 User: ${latestUserText}`);

  // ── DRAFT STATE ──────────────────────────────────────────
  let draft = {
    partySize:      freshCall.bookingDraft?.partySize      ?? null,
    requestedStart: freshCall.bookingDraft?.requestedStart ?? null,
    customerName:   freshCall.bookingDraft?.customerName   ?? null,
    customerPhone:  freshCall.bookingDraft?.customerPhone  ?? callerPhone,
  };

  let orderDraft = {
    items:           freshCall.orderDraft?.items           ?? [],
    orderType:       freshCall.orderDraft?.orderType       ?? null,
    status:          freshCall.orderDraft?.status          ?? null,
    deliveryAddress: freshCall.orderDraft?.deliveryAddress ?? null,
  };

  // ── BOOKING INTENT RESET ─────────────────────────────────
  if (looksLikeBookingIntent(latestUserText) && !looksLikeOrderIntent(latestUserText)) {
    orderDraft.orderType = null;
    orderDraft.status = null;
    if (orderDraft.items?.length === 0) {
      draft.requestedStart = null;
      draft.partySize = null;
    }
    await Call.updateOne({ _id: freshCall._id }, {
      $set: {
        "orderDraft.orderType": null,
        "orderDraft.status": null,
        ...(orderDraft.items?.length === 0 ? {
          "bookingDraft.requestedStart": null,
          "bookingDraft.partySize": null,
        } : {}),
      }
    });
  }

  // ── RETURNING CALLER ─────────────────────────────────────
  let returningContext = null;
  let returningBooking = null;
  let returningOrder = null;
  let awaitingReturnConfirmation = freshCall.meta?.awaitingReturnConfirmation ?? false;
  let returnConfirmed = freshCall.meta?.returnConfirmed ?? false;

  const mentionsChange = /\b(cancel|change|modify|update|edit|fix|correct|i called|earlier|last time|my order|my booking|placed an order|made a booking)\b/i.test(latestUserText);

  if (callerPhone && mentionsChange && !awaitingReturnConfirmation && !returnConfirmed) {
    const previousCall = await Call.findOne({
      _id: { $ne: freshCall._id },
      $or: [{ callerNumber: callerPhone }, { "bookingDraft.customerPhone": callerPhone }],
      agentId: freshCall.agentId,
    }).sort({ createdAt: -1 }).lean();

    if (previousCall) {
      const prevBooking = await Booking.findOne({ callId: previousCall.callId, status: { $in: ["confirmed","seated"] } }).lean();
      const prevOrder = await Order.findOne({ callId: previousCall.callId, status: { $in: ["confirmed","preparing","ready"] } }).lean();

      if (prevBooking || prevOrder) {
        const name = prevBooking?.customerName || prevOrder?.customerName;
        if (name) {
          if (prevBooking) {
            const timeStr = new Date(prevBooking.startTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
            returningContext = `Booking for ${prevBooking.partySize} people at ${timeStr} under ${name}`;
          } else if (prevOrder) {
            const itemsSummary = prevOrder.items.map(i => `${i.name} x${i.quantity}`).join(", ");
            returningContext = `${prevOrder.orderType} order: ${itemsSummary} under ${name}`;
          }

          await Call.updateOne({ _id: freshCall._id }, {
            $set: {
              "meta.awaitingReturnConfirmation": true,
              "meta.returningName": name,
              "meta.returningBookingId": prevBooking?._id?.toString() ?? null,
              "meta.returningOrderId": prevOrder?._id?.toString() ?? null,
            }
          });

          console.log(`📞 Returning caller detected: ${name}`);
          return { response: `${name}? Is that right?` };
        }
      }
    }
  }

  // ── RETURNING CALLER CONFIRMATION ────────────────────────
  if (awaitingReturnConfirmation && !returnConfirmed) {
    const isYes = /\b(yes|yeah|yep|correct|that's me|right|yup|sure|exactly|affirmative)\b/i.test(latestUserText);
    const isNo = /\b(no|nope|wrong|not me|different|incorrect)\b/i.test(latestUserText);

    if (isYes) {
      const returningName = freshCall.meta?.returningName;
      const returningBookingId = freshCall.meta?.returningBookingId;
      const returningOrderId = freshCall.meta?.returningOrderId;

      draft.customerName = returningName;
      await Call.updateOne({ _id: freshCall._id }, {
        $set: { "meta.returnConfirmed": true, "meta.awaitingReturnConfirmation": false, "bookingDraft.customerName": returningName }
      });

      let contextMsg = "";
      if (returningBookingId) {
        const rb = await Booking.findById(returningBookingId).lean();
        if (rb) {
          const timeStr = new Date(rb.startTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
          contextMsg = `I have your table booking for ${rb.partySize} at ${timeStr}.`;
        }
      }
      if (!contextMsg && returningOrderId) {
        const ro = await Order.findById(returningOrderId).lean();
        if (ro) {
          const itemsSummary = ro.items.map(i => `${i.name} x${i.quantity}`).join(", ");
          contextMsg = `I have your ${ro.orderType} order for ${itemsSummary}.`;
        }
      }
      return { response: `Great! ${contextMsg} How can I help you?` };
    }

    if (isNo) {
      await Call.updateOne({ _id: freshCall._id }, {
        $set: { "meta.awaitingReturnConfirmation": false, "meta.returnConfirmed": false }
      });
      return { response: "I'm sorry about that! How can I help you today?" };
    }

    return { response: `Sorry, I didn't catch that. Is this ${freshCall.meta?.returningName}?` };
  }

  // ── CONFIRMED IDs ─────────────────────────────────────────
  const confirmedBookingId = freshCall.meta?.returningBookingId ?? null;
  const confirmedOrderId = freshCall.meta?.returningOrderId ?? null;
  returnConfirmed = freshCall.meta?.returnConfirmed ?? false;

  // ── INTENT DETECTION ─────────────────────────────────────
  const recentTranscriptText = transcript.slice(-4).map(t => t.content).join(" ");
  const cancelIntent = looksLikeCancelIntent(latestUserText);
  const modifyIntent = looksLikeModifyIntent(latestUserText);

  const bookingFlowActive =
    !!draft.partySize || !!draft.requestedStart ||
    (!returnConfirmed && !!draft.customerName) ||
    looksLikeBookingIntent(latestUserText) || looksLikeBookingIntent(recentTranscriptText);

  const orderFlowActive =
    agent.features?.orders === true && (
      !!orderDraft.items?.length || !!orderDraft.orderType ||
      looksLikeOrderIntent(latestUserText) || looksLikeOrderIntent(recentTranscriptText)
    );

  // ── CANCEL — RETURNING CALLER ─────────────────────────────
  if (cancelIntent && returnConfirmed) {
    const wantsToCancel = latestUserText.toLowerCase();

    if (confirmedBookingId && (wantsToCancel.includes("book") || wantsToCancel.includes("reserv") || wantsToCancel.includes("table") || !wantsToCancel.includes("order"))) {
      const booking = await Booking.findById(confirmedBookingId);
      if (booking) {
        await Booking.updateOne({ _id: confirmedBookingId }, { $set: { status: "cancelled" } });
        await Call.updateOne({ _id: freshCall._id }, { $set: { "meta.returningBookingId": null, "bookingDraft.partySize": null, "bookingDraft.requestedStart": null, "bookingDraft.customerName": null } });
        return { response: `Done! Your booking has been cancelled. Is there anything else I can help you with?` };
      }
    }

    if (confirmedOrderId) {
      const order = await Order.findById(confirmedOrderId);
      if (order) {
        const mins = (Date.now() - new Date(order.createdAt).getTime()) / 60000;
        if (mins > 5) return { response: `I'm sorry, your order was placed ${Math.floor(mins)} minutes ago and cannot be cancelled.` };
        await Order.updateOne({ _id: confirmedOrderId }, { $set: { status: "cancelled" } });
        await Call.updateOne({ _id: freshCall._id }, { $set: { "meta.returningOrderId": null, "orderDraft.items": [], "orderDraft.orderType": null, "orderDraft.status": null, "orderDraft.deliveryAddress": null } });
        return { response: `Done! Your order has been cancelled. Is there anything else I can help you with?` };
      }
    }
  }

  // ── CANCEL — SAME CALL ────────────────────────────────────
  if (cancelIntent && orderDraft.status === "confirmed") {
    const existingOrder = await Order.findOne({ callId, status: { $in: ["confirmed","preparing"] } }).sort({ createdAt: -1 });
    if (existingOrder) {
      const mins = (Date.now() - new Date(existingOrder.createdAt).getTime()) / 60000;
      if (mins > 5) return { response: `I'm sorry, your order was placed ${Math.floor(mins)} minutes ago and cannot be cancelled.` };
      await Order.updateOne({ _id: existingOrder._id }, { $set: { status: "cancelled" } });
      await Call.updateOne({ _id: freshCall._id }, { $set: { "orderDraft.items": [], "orderDraft.orderType": null, "orderDraft.status": "cancelled", "orderDraft.deliveryAddress": null } });
      return { response: "Done! Your order has been cancelled. Is there anything else I can help you with?" };
    }
  }

  if (cancelIntent && (bookingFlowActive || looksLikeBookingIntent(latestUserText))) {
    const existingBooking = await Booking.findOne({ callId, status: { $in: ["confirmed","seated"] } });
    if (existingBooking) {
      await Booking.updateOne({ _id: existingBooking._id }, { $set: { status: "cancelled" } });
      await Call.updateOne({ _id: freshCall._id }, { $set: { "bookingDraft.partySize": null, "bookingDraft.requestedStart": null, "bookingDraft.customerName": null } });
      return { response: "Done! Your booking has been cancelled. Is there anything else I can help you with?" };
    }
  }

  // ── MODIFY — RETURNING CALLER ─────────────────────────────
  if (modifyIntent && returnConfirmed && confirmedOrderId) {
    const existingOrder = await Order.findById(confirmedOrderId);
    if (existingOrder) {
      const mins = (Date.now() - new Date(existingOrder.createdAt).getTime()) / 60000;
      if (mins > 5) return { response: `I'm sorry, your order was placed ${Math.floor(mins)} minutes ago and cannot be modified.` };
      orderDraft.items = existingOrder.items;
      orderDraft.orderType = existingOrder.orderType;
      orderDraft.deliveryAddress = existingOrder.deliveryAddress;
      orderDraft.status = null;
      await Call.updateOne({ _id: freshCall._id }, {
        $set: { "orderDraft.items": existingOrder.items, "orderDraft.orderType": existingOrder.orderType, "orderDraft.deliveryAddress": existingOrder.deliveryAddress, "orderDraft.status": null }
      });
    }
  }

  // ── ORDER CONFIRMED — handle next action ──────────────────
  if (orderDraft.status === "confirmed") {
    if (/\b(bye|goodbye|bye bye|thank you|thanks|that's all|nothing else|no thank)\b/i.test(latestUserText)) {
      return { response: "Thank you for calling! Have a wonderful day. Goodbye!", end_call: true };
    }
    if (looksLikeOrderIntent(latestUserText) && !modifyIntent && !cancelIntent) {
      orderDraft = { items: [], orderType: null, status: null, deliveryAddress: null };
      await Call.updateOne({ _id: freshCall._id }, { $set: { "orderDraft.items": [], "orderDraft.orderType": null, "orderDraft.status": null, "orderDraft.deliveryAddress": null } });
    } else if (looksLikeBookingIntent(latestUserText)) {
      // fall through to booking flow
    } else if (modifyIntent || cancelIntent) {
      const existingOrder = await Order.findOne({ callId, status: { $in: ["confirmed","preparing"] } }).sort({ createdAt: -1 });
      if (existingOrder) {
        const mins = (Date.now() - new Date(existingOrder.createdAt).getTime()) / 60000;
        if (mins > 5) return { response: `I'm sorry, your order was placed ${Math.floor(mins)} minutes ago and cannot be modified.` };
        const mentionsAddress = /\b(address|location|deliver|where)\b/i.test(latestUserText);
        orderDraft.items = existingOrder.items;
        orderDraft.orderType = existingOrder.orderType;
        orderDraft.deliveryAddress = mentionsAddress ? null : existingOrder.deliveryAddress;
        orderDraft.status = null;
        await Call.updateOne({ _id: freshCall._id }, {
          $set: { "orderDraft.items": existingOrder.items, "orderDraft.orderType": existingOrder.orderType, "orderDraft.deliveryAddress": mentionsAddress ? null : existingOrder.deliveryAddress, "orderDraft.status": null }
        });
        if (mentionsAddress) return { response: "Sure! What is the new delivery address?" };
      }
    } else {
      return { response: "Is there anything else I can help you with?" };
    }
  }

  // ── ACTIVE FLOW ───────────────────────────────────────────
  if (bookingFlowActive || orderFlowActive || cancelIntent || modifyIntent) {

    if (/\b(bye|goodbye|bye bye|thank you|thanks|that's all|nothing else|no thank)\b/i.test(latestUserText)) {
      return { response: "Thank you for calling! Have a wonderful day. Goodbye!", end_call: true };
    }

    const returningCtxString = returningContext ||
      (confirmedBookingId ? `Has existing booking` : null) ||
      (confirmedOrderId ? `Has existing order` : null);

    const { extracted, orderExtracted, intent, response: aiResponse } =
      await extractAndRespond(latestUserText, draft, orderDraft, transcript, agent, returningCtxString);

    console.log("🧠 Extracted:", extracted);
    console.log("🛒 Order extracted:", orderExtracted);
    console.log("🎯 Intent:", intent);

    // Update booking draft
    if (extracted.partySize && !draft.partySize) draft.partySize = extracted.partySize;
    if (extracted.time && !draft.requestedStart) {
      try {
        const [h, m] = extracted.time.split(":").map(Number);
        const d = new Date();
        d.setHours(h, m || 0, 0, 0);
        draft.requestedStart = d;
      } catch (e) { console.error("❌ Time parse:", e); }
    }
    if (extracted.name) draft.customerName = extracted.name;

    // Update order items
    if (orderExtracted.items?.length > 0) {
      const normalizedItems = orderExtracted.items.map(item =>
        typeof item === "string"
          ? { name: item, quantity: 1, extras: [] }
          : { name: item.name || item.item, quantity: item.quantity || 1, extras: item.extras || [] }
      );
      const validItems = normalizedItems.filter(item =>
        item?.name && agent.menu?.some(m => m.name.toLowerCase() === item.name.toLowerCase() && m.available)
      );
      for (const newItem of validItems) {
        const existingIndex = orderDraft.items.findIndex(e => e.name.toLowerCase() === newItem.name.toLowerCase());
        if (existingIndex >= 0) {
          orderDraft.items[existingIndex].quantity = newItem.quantity || 1;
        } else {
          orderDraft.items.push(newItem);
        }
      }
    }

    if (orderExtracted.orderType) orderDraft.orderType = orderExtracted.orderType;
    if (orderExtracted.deliveryAddress) orderDraft.deliveryAddress = orderExtracted.deliveryAddress;

    // Save drafts
    await Call.updateOne({ _id: freshCall._id }, {
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
    });

    console.log("📋 Booking draft:", draft);
    console.log("🛒 Order draft:", orderDraft);

    // ── COMPLETION CHECKS ─────────────────────────────────
    const bookingComplete =
      bookingFlowActive &&
      orderDraft.items?.length === 0 &&
      !orderDraft.orderType &&
      draft.partySize && draft.requestedStart && draft.customerName;

    const dineInComplete =
      (orderDraft.orderType === "dineIn" || (orderDraft.items?.length > 0 && draft.partySize && draft.requestedStart)) &&
      orderDraft.items?.length > 0 &&
      draft.partySize && draft.requestedStart && draft.customerName;
      
    const pickupComplete =
      orderDraft.orderType === "pickup" &&
      orderDraft.items?.length > 0 &&
      draft.requestedStart &&
      draft.customerName;

    const deliveryComplete =
      orderDraft.orderType === "delivery" &&
      orderDraft.items?.length > 0 &&
      orderDraft.deliveryAddress &&
      draft.customerName;

    if (aiResponse && !bookingComplete && !dineInComplete && !pickupComplete && !deliveryComplete) {
      return { response: aiResponse };
    }

    // Force orderType to dineIn if all fields collected but orderType is null
    if (dineInComplete && !orderDraft.orderType) {
      orderDraft.orderType = "dineIn";
    }

  
    // ── DINE-IN ───────────────────────────────────────────
    if (dineInComplete) {
      if (processingCalls.has(callId)) return { response: "One moment please..." };
      processingCalls.add(callId);
      try {
        const existingOrder = confirmedOrderId ? await Order.findById(confirmedOrderId) : null;
        const total = orderDraft.items.reduce((sum, item) => {
          const mi = agent.menu?.find(m => m.name.toLowerCase() === item.name.toLowerCase());
          return sum + (mi?.price || 0) * (item.quantity || 1);
        }, 0);
        const orderItems = orderDraft.items.map(item => {
          const mi = agent.menu?.find(m => m.name.toLowerCase() === item.name.toLowerCase());
          return { name: item.name, quantity: item.quantity || 1, price: mi?.price || 0, extras: item.extras || [] };
        });

        if (existingOrder) {
          await Order.updateOne({ _id: existingOrder._id }, { $set: { items: orderItems, total, status: "confirmed" } });
        }

        const existingBooking = await Booking.findOne({ callId, status: { $in: ["confirmed","seated"] } });
        const result = existingBooking
          ? { success: true, booking: { startIso: existingBooking.startTime } }
          : await findNearestAvailableSlot({ businessId: agent.businessId, requestedStart: draft.requestedStart, durationMinutes: 90, partySize: draft.partySize, source: "ai", agentId: agent._id, callId, customerName: draft.customerName, customerPhone: draft.customerPhone });

        if (existingBooking) {
          await Booking.updateOne({ _id: existingBooking._id }, { $set: { partySize: draft.partySize, startTime: draft.requestedStart } });
        }

        if (result?.success) {
          if (!existingOrder) {
            await Order.create({ callId, businessId: agent.businessId, agentId: agent._id, customerName: draft.customerName, customerPhone: draft.customerPhone || callerPhone, items: orderItems, orderType: "dineIn", total, status: "confirmed" });
          }
          await Call.updateOne({ _id: freshCall._id }, { $set: { "bookingDraft.partySize": null, "bookingDraft.requestedStart": null, "bookingDraft.customerName": null, "orderDraft.items": [], "orderDraft.orderType": null, "orderDraft.deliveryAddress": null, "orderDraft.status": "confirmed" } });
          const timeString = new Date(draft.requestedStart).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
          const itemsSummary = orderDraft.items.map(i => `${i.name} x${i.quantity || 1}`).join(", ");
          console.log("✅ Dine-in confirmed");
          return { response: `Perfect! Your table for ${draft.partySize} is booked at ${timeString} under ${draft.customerName}, and your ${itemsSummary} will be ready when you arrive. Total is ${total} AED. Is there anything else I can help you with?` };
        }
        if (result?.suggestedTime) {
          const s = new Date(result.suggestedTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
          return { response: `We're fully booked at that time. Would ${s} work instead?` };
        }
        return { response: "I'm sorry, we don't have availability at that time. Would you like a different time?" };
      } catch (err) {
        console.error("❌ Dine-in error:", err.message);
        return { response: "Something went wrong. Please try again." };
      } finally {
        processingCalls.delete(callId);
      }
    }

    // ── BOOKING ONLY ──────────────────────────────────────
    if (bookingComplete) {
      if (processingCalls.has(callId)) return { response: "One moment please..." };
      processingCalls.add(callId);
      try {
        const existingBooking = await Booking.findOne({
          $or: [
            { callId, status: { $in: ["confirmed","seated"] } },
            ...(confirmedBookingId ? [{ _id: confirmedBookingId }] : []),
          ]
        });

        if (existingBooking) {
          await Booking.updateOne({ _id: existingBooking._id }, { $set: { partySize: draft.partySize, startTime: draft.requestedStart, customerName: draft.customerName } });
          await Call.updateOne({ _id: freshCall._id }, { $set: { "bookingDraft.partySize": null, "bookingDraft.requestedStart": null, "bookingDraft.customerName": null } });
          const timeString = new Date(draft.requestedStart).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
          console.log("✅ Booking updated");
          return { response: `Done! Your booking has been updated to ${draft.partySize} people at ${timeString} under ${draft.customerName}. Is there anything else I can help you with?` };
        }

        const result = await findNearestAvailableSlot({ businessId: agent.businessId, requestedStart: draft.requestedStart, durationMinutes: 90, partySize: draft.partySize, source: "ai", agentId: agent._id, callId, customerName: draft.customerName, customerPhone: draft.customerPhone });

        if (result?.success && result.booking) {
          await Call.updateOne({ _id: freshCall._id }, { $set: { "bookingDraft.partySize": null, "bookingDraft.requestedStart": null, "bookingDraft.customerName": null } });
          const timeString = new Date(result.booking.startIso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
          console.log("✅ Booking confirmed");
          return { response: `Perfect! Your table for ${draft.partySize} is confirmed at ${timeString} under ${draft.customerName}. Is there anything else I can help you with?` };
        }
        if (result?.suggestedTime) {
          const s = new Date(result.suggestedTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
          return { response: `We're fully booked at that time. Would ${s} work instead?` };
        }
        return { response: "I'm sorry, we don't have availability at that time. Would you like a different time?" };
      } catch (err) {
        console.error("❌ Booking error:", err.message);
        return { response: "Something went wrong. Please try again." };
      } finally {
        processingCalls.delete(callId);
      }
    }

    // ── PICKUP OR DELIVERY ────────────────────────────────
    if (pickupComplete || deliveryComplete) {
      const existingOrder = confirmedOrderId ? await Order.findById(confirmedOrderId) : null;

      const total = orderDraft.items.reduce((sum, item) => {
        const mi = agent.menu?.find(m => m.name.toLowerCase() === item.name.toLowerCase());
        return sum + (mi?.price || 0) * (item.quantity || 1);
      }, 0);
      const orderItems = orderDraft.items.map(item => {
        const mi = agent.menu?.find(m => m.name.toLowerCase() === item.name.toLowerCase());
        return { name: item.name, quantity: item.quantity || 1, price: mi?.price || 0, extras: item.extras || [] };
      });

      if (existingOrder) {
        const updatedAddress = orderDraft.deliveryAddress || existingOrder.deliveryAddress;
        await Order.updateOne({ _id: existingOrder._id }, { $set: { items: orderItems, deliveryAddress: updatedAddress, orderType: orderDraft.orderType, customerName: draft.customerName, total, status: "confirmed" } });
        orderDraft.deliveryAddress = updatedAddress;
        console.log("✅ Order updated:", orderDraft.orderType);
      } else {
        // Double-check no order was saved by a parallel request
        const raceCheck = await Order.findOne({ callId, orderType: orderDraft.orderType, status: "confirmed", createdAt: { $gte: new Date(Date.now() - 5000) } });
        if (raceCheck) {
          console.log("⏭ Order already saved by parallel request, skipping");
          const itemsSummary = orderDraft.items.map(i => `${i.name} x${i.quantity || 1}`).join(", ");
          const confirmMsg = orderDraft.orderType === "delivery"
            ? `Perfect! Your order for ${itemsSummary} will be delivered to ${orderDraft.deliveryAddress} under ${draft.customerName}. Total is ${total} AED. Is there anything else I can help you with?`
            : `Perfect! Your order for ${itemsSummary} is ready for pickup under ${draft.customerName}. Total is ${total} AED. Is there anything else I can help you with?`;
          return { response: confirmMsg };
        }
        await Order.create({ callId, businessId: agent.businessId, agentId: agent._id, customerName: draft.customerName, customerPhone: draft.customerPhone || callerPhone, deliveryAddress: orderDraft.deliveryAddress || null, items: orderItems, orderType: orderDraft.orderType, total, status: "confirmed" });
        console.log("✅ Order saved:", orderDraft.orderType);
      }

      await Call.updateOne({ _id: freshCall._id }, { $set: { "orderDraft.items": [], "orderDraft.orderType": null, "orderDraft.deliveryAddress": null, "orderDraft.status": "confirmed" } });
      

      const itemsSummary = orderDraft.items.map(i => `${i.name} x${i.quantity || 1}`).join(", ");
      const confirmMsg = orderDraft.orderType === "delivery"
        ? `Perfect! Your order for ${itemsSummary} will be delivered to ${orderDraft.deliveryAddress} under ${draft.customerName}. Total is ${total} AED. Is there anything else I can help you with?`
        : `Perfect! Your order for ${itemsSummary} is ready for pickup under ${draft.customerName}. Total is ${total} AED. Is there anything else I can help you with?`;

      // Clear in-memory draft immediately to prevent leaking into next flow
      orderDraft.items = [];
      orderDraft.orderType = null;
      orderDraft.deliveryAddress = null;
      orderDraft.status = "confirmed";

      return { response: confirmMsg };
    }

   // Fallback with context-aware hints
    if (orderDraft.orderType === "delivery" && orderDraft.items?.length > 0 && !orderDraft.deliveryAddress) {
      return { response: "What is the delivery address?" };
    }
    if (orderDraft.orderType === "delivery" && orderDraft.items?.length > 0 && orderDraft.deliveryAddress && !draft.customerName) {
      return { response: "What name should I put the order under?" };
    }
    if (orderDraft.orderType === "pickup" && orderDraft.items?.length > 0 && !draft.requestedStart) {
      return { response: "What time would you like to pick up your order?" };
    }
    if (orderDraft.orderType === "pickup" && orderDraft.items?.length > 0 && !draft.customerName) {
      return { response: "What name should I put the order under?" };
    }
    if (orderDraft.orderType === "dineIn" && orderDraft.items?.length > 0 && draft.partySize && draft.requestedStart && !draft.customerName) {
      return { response: "What name should I put the reservation under?" };
    }
    return { response: aiResponse || "How can I help you?" };
  }

  // ── GOODBYE ───────────────────────────────────────────────
  if (/\b(bye|goodbye|thank you|thanks|that's all|nothing else|no thank|bye bye)\b/i.test(latestUserText)) {
    return { response: "Thank you for calling! Have a wonderful day. Goodbye!", end_call: true };
  }

  // ── GENERAL FALLBACK ──────────────────────────────────────
  const isJustGreeting = /^(hi|hello|hey|good morning|good evening|good afternoon|howdy|greetings)[\s\?\!\.]*$/i.test(latestUserText.trim());
  if (isJustGreeting) {
    return { response: "How can I help you today?" };
  }

  const systemPrompt = buildSystemPrompt(agent);
  const conversationHistory = transcript.slice(-6).map(t => ({
    role: t.role === "agent" ? "assistant" : "user",
    content: t.content,
  }));

  const aiReply = await getAIResponse([
    { role: "system", content: systemPrompt },
    ...conversationHistory,
    { role: "user", content: latestUserText || "Hello" },
  ]);

  return { response: aiReply || "How can I help you today?" };
}

module.exports = { processLLMMessage };