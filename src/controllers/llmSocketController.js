// src/controllers/llmSocketController.js

const Agent = require("../models/Agent");
const Call = require("../models/Call");
const Booking = require("../models/Booking");
const Order = require("../models/Order");
const { getAIResponse } = require("../services/aiChatService");
const { findNearestAvailableSlot } = require("../services/bookingService");

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
  return Object.entries(categories).map(([cat, items]) => {
    const lines = items.map(i => {
      let line = `- ${i.name}: ${i.price} ${i.currency || "AED"}`;
      if (i.description) line += ` (${i.description})`;
      if (i.extras?.length) line += ` [Extras: ${i.extras.map(e => `${e.name}+${e.price}`).join(", ")}]`;
      return line;
    });
    return `${cat}: ${lines.join(", ")}`;
  }).join("\n");
}

function formatOpeningHours(openingHours) {
  if (!openingHours) return "Not set.";
  const days = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];
  return days.map(day => {
    const h = openingHours[day];
    if (!h || h.closed) return `${day}: Closed`;
    if (!h.open && !h.close) return `${day}: Hours not set`;
    return `${day}: ${h.open}-${h.close}`;
  }).join(", ");
}

function buildSystemPrompt(agent) {
  const basePrompt = agent.agentPrompt?.trim()
    ? agent.agentPrompt
    : `You are a friendly receptionist at ${agent.businessName}.`;
  return `${basePrompt}
Opening hours: ${formatOpeningHours(agent.openingHours)}
${agent.features?.orders && agent.menu?.length > 0 ? `Menu:\n${formatMenu(agent.menu)}` : ""}
Rules: Keep responses short. Never ask for phone number. Never mention dates, only times. Be warm and professional.`;
}

function looksLikeBookingIntent(text) {
  if (!text) return false;
  return /\b(book|reserve|reservation|table)\b/i.test(text);
}

function looksLikeOrderIntent(text) {
  if (!text) return false;
  return /\b(order|food|eat|hungry|menu|delivery|pickup|take.?away)\b/i.test(text);
}

// ─── EXTRACTION ──────────────────────────────────────────────────────────────

async function extractAndRespond(text, draft, orderDraft, transcript, agent) {
  if (!text?.trim()) return { extracted: {}, orderExtracted: {}, response: null };

  const recentConvo = (transcript ?? []).slice(-4)
    .map(t => `${t.role === "agent" ? "A" : "C"}: ${t.content}`)
    .join("\n");

  const menuText = agent.features?.orders && agent.menu?.length > 0
    ? `Menu: ${formatMenu(agent.menu)}`
    : "";

  // Compact prompt to reduce tokens and speed up response
  const prompt = `You are a receptionist at ${agent.businessName}.
State: partySize=${draft.partySize ?? "?"}, time=${draft.requestedStart ? new Date(draft.requestedStart).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:true}) : "?"}, name=${draft.customerName ?? "?"}, orderItems=${orderDraft.items?.length > 0 ? orderDraft.items.map(i=>`${i.name}x${i.quantity}`).join(",") : "none"}, orderType=${orderDraft.orderType ?? "?"}, address=${orderDraft.deliveryAddress ?? "?"}
${menuText}
Conversation:
${recentConvo}
Customer: "${text}"

Extract info and respond naturally. Rules:
- NEVER suggest or ask about ordering after a booking unless customer brings it up
- pickup/delivery: ask what they want to order FIRST, then address (delivery only), then name
- dineIn: collect food, partySize, time, name
- NEVER ask partySize or time for pickup/delivery
- Capture delivery address EXACTLY as spoken word for word
- If customer says bye/thanks/goodbye return a short farewell as response

JSON only:
{"extracted":{"partySize":null,"time":null,"name":null},"orderExtracted":{"items":[],"orderType":null,"deliveryAddress":null},"response":"your reply or null"}`;

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 150,
        temperature: 0.3,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content?.trim() ?? "{}";
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    return {
      extracted: parsed.extracted ?? {},
      orderExtracted: parsed.orderExtracted ?? {},
      response: parsed.response ?? null,
    };
  } catch (err) {
    console.error("❌ OpenAI error:", err.message);
    return { extracted: {}, orderExtracted: {}, response: null };
  }
}

// ─── IN-MEMORY LOCKS ─────────────────────────────────────────────────────────

const processingCalls = new Set();
const respondedIds = new Map(); // prevent duplicate responses per response_id

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function processLLMMessage(body, req) {
  const interactionType = body.interaction_type || body.type;
  if (interactionType === "ping_pong") return null;
  if (interactionType !== "response_required") return null;

  // Deduplicate by response_id to prevent parallel processing
  const responseId = body.response_id;
  if (responseId !== undefined) {
    if (respondedIds.has(responseId)) return null;
    respondedIds.set(responseId, true);
    // Clean up old entries
    if (respondedIds.size > 50) {
      const firstKey = respondedIds.keys().next().value;
      respondedIds.delete(firstKey);
    }
  }

  // ── CALL ID ──────────────────────────────────────────────
  let callId = body.call_id || body.callId || body?.metadata?.call_id || null;
  if (!callId && req?.url) {
    const parts = req.url.split("/");
    const last = parts[parts.length - 1];
    if (last?.startsWith("call_")) callId = last;
  }
  if (!callId) return { response: "Sorry, something went wrong." };

  // ── SINGLE DB QUERY ──────────────────────────────────────
  const freshCall = await Call.findOne({
    $or: [{ callId }, { call_id: callId }],
  }).lean();
  if (!freshCall) return { response: "Sorry, something went wrong." };

  const agent = await Agent.findById(freshCall.agentId).lean();
  if (!agent) return { response: "Sorry, something went wrong." };

  // ── PHONE ────────────────────────────────────────────────
  const phoneFromBody =
    body?.call?.from_number || body?.call?.caller_id ||
    body?.call?.from || body?.call?.customer_number || body?.from_number || null;

  if (!freshCall.callerNumber && phoneFromBody) {
    await Call.updateOne({ _id: freshCall._id }, { $set: { callerNumber: phoneFromBody } });
  }
  const callerPhone = freshCall.callerNumber || phoneFromBody || null;

  // ── TEXT + TRANSCRIPT ────────────────────────────────────
  const latestUserText = typeof body.latest_user_text === "string"
    ? body.latest_user_text.trim() : "";
  const transcript = body.transcript ?? [];

  console.log(`🗣 User: ${latestUserText}`);
  console.log("🎯 LLM CONTROLLER HIT");

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

  // ── IF ORDER ALREADY CONFIRMED → just handle conversation ─
  if (orderDraft.status === "confirmed") {
    if (/\b(bye|goodbye|thank|thanks|done|finished|nothing|no)\b/i.test(latestUserText)) {
      return { response: "Thank you! Have a wonderful day. Goodbye!", end_call: true };
    }
    // Check if they want something new
    if (looksLikeBookingIntent(latestUserText) || looksLikeOrderIntent(latestUserText)) {
      // Reset order draft and continue below
      orderDraft = { items: [], orderType: null, status: null, deliveryAddress: null };
      await Call.updateOne({ _id: freshCall._id }, {
        $set: {
          "orderDraft.items": [],
          "orderDraft.orderType": null,
          "orderDraft.status": null,
          "orderDraft.deliveryAddress": null,
        }
      });
    } else {
      return { response: "Is there anything else I can help you with?" };
    }
  }

  // ── INTENT DETECTION ─────────────────────────────────────
  const recentText = transcript.slice(-4).map(t => t.content).join(" ");

  const bookingFlowActive =
    !!draft.partySize || !!draft.requestedStart || !!draft.customerName ||
    looksLikeBookingIntent(latestUserText) || looksLikeBookingIntent(recentText);

  const orderFlowActive =
    agent.features?.orders === true && (
      !!orderDraft.items?.length || !!orderDraft.orderType ||
      looksLikeOrderIntent(latestUserText) || looksLikeOrderIntent(recentText)
    );

  // ── ACTIVE FLOW ───────────────────────────────────────────
  if (bookingFlowActive || orderFlowActive) {

    // ── CHECK: all booking fields collected → go straight to engine ──
    const bookingComplete = draft.partySize && draft.requestedStart && draft.customerName;
    const orderComplete =
      orderDraft.items?.length > 0 &&
      orderDraft.orderType &&
      draft.customerName &&
      (orderDraft.orderType !== "delivery" || orderDraft.deliveryAddress) &&
      (orderDraft.orderType !== "dineIn" || (draft.partySize && draft.requestedStart));

    // Only call AI if we still need more info
    let aiResponse = null;
    let extracted = {};
    let orderExtracted = {};

    if (!bookingComplete || !orderComplete) {
      const result = await extractAndRespond(latestUserText, draft, orderDraft, transcript, agent);
      extracted = result.extracted;
      orderExtracted = result.orderExtracted;
      aiResponse = result.response;

      console.log("🎯 Extraction:", { extracted, orderExtracted, response: aiResponse });
    }

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
    if (extracted.name && !draft.customerName) draft.customerName = extracted.name;

    // Update order draft — deduplicated
    if (orderExtracted.items?.length > 0) {
      const validItems = orderExtracted.items.filter(item =>
        agent.menu?.some(m => m.name.toLowerCase() === item.name.toLowerCase() && m.available)
      );
      for (const newItem of validItems) {
        const exists = orderDraft.items.some(e => e.name.toLowerCase() === newItem.name.toLowerCase());
        if (!exists) orderDraft.items.push(newItem);
      }
    }
    if (orderExtracted.orderType && !orderDraft.orderType) orderDraft.orderType = orderExtracted.orderType;
    if (orderExtracted.deliveryAddress && !orderDraft.deliveryAddress) {
      orderDraft.deliveryAddress = orderExtracted.deliveryAddress;
    }

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

    // ── DINE-IN: ORDER + BOOKING ──────────────────────────
    if (
      orderFlowActive && orderDraft.orderType === "dineIn" &&
      orderDraft.items?.length > 0 &&
      draft.partySize && draft.requestedStart && draft.customerName
    ) {
      if (processingCalls.has(callId)) return { response: "One moment please..." };
      processingCalls.add(callId);
      try {
        const existingOrder = await Order.findOne({ callId });
        if (existingOrder) return { response: `Your order and table are already confirmed under ${draft.customerName}. Is there anything else I can help you with?` };

        const result = await findNearestAvailableSlot({
          businessId: agent.businessId, requestedStart: draft.requestedStart,
          durationMinutes: 90, partySize: draft.partySize, source: "ai",
          agentId: agent._id, callId, customerName: draft.customerName, customerPhone: draft.customerPhone,
        });

        if (result?.success && result.booking) {
          const total = orderDraft.items.reduce((sum, item) => {
            const m = agent.menu?.find(m => m.name.toLowerCase() === item.name.toLowerCase());
            return sum + (m?.price || 0) * (item.quantity || 1);
          }, 0);

          await Order.create({
            callId, businessId: agent.businessId, agentId: agent._id,
            customerName: draft.customerName, customerPhone: draft.customerPhone || callerPhone,
            items: orderDraft.items.map(item => {
              const m = agent.menu?.find(m => m.name.toLowerCase() === item.name.toLowerCase());
              return { name: item.name, quantity: item.quantity || 1, price: m?.price || 0, extras: item.extras || [] };
            }),
            orderType: "dineIn", total, status: "confirmed",
          });

          await Call.updateOne({ _id: freshCall._id }, {
            $set: {
              "bookingDraft.partySize": null, "bookingDraft.requestedStart": null, "bookingDraft.customerName": null,
              "orderDraft.items": [], "orderDraft.orderType": null,
              "orderDraft.deliveryAddress": null, "orderDraft.status": "confirmed",
            },
          });

          const timeStr = new Date(result.booking.startIso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
          const itemsSummary = orderDraft.items.map(i => `${i.name} x${i.quantity || 1}`).join(", ");
          console.log("✅ Dine-in order + booking confirmed");
          return { response: `Perfect! Your table for ${draft.partySize} is booked at ${timeStr} under ${draft.customerName}, and your ${itemsSummary} will be ready when you arrive. Total is ${total} AED. Is there anything else I can help you with?` };
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
    if (bookingFlowActive && !orderFlowActive && draft.partySize && draft.requestedStart && draft.customerName) {
      const existing = await Booking.findOne({ callId, status: { $in: ["confirmed", "seated"] } });
      if (existing) return { response: `Your reservation is already confirmed under ${draft.customerName}. Is there anything else I can help you with?` };

      if (processingCalls.has(callId)) return { response: "One moment please..." };
      processingCalls.add(callId);
      try {
        const result = await findNearestAvailableSlot({
          businessId: agent.businessId, requestedStart: draft.requestedStart,
          durationMinutes: 90, partySize: draft.partySize, source: "ai",
          agentId: agent._id, callId, customerName: draft.customerName, customerPhone: draft.customerPhone,
        });

        if (result?.success && result.booking) {
          await Call.updateOne({ _id: freshCall._id }, {
            $set: { "bookingDraft.partySize": null, "bookingDraft.requestedStart": null, "bookingDraft.customerName": null },
          });
          const timeStr = new Date(result.booking.startIso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
          console.log("✅ Booking confirmed");
          return { response: `Perfect! Your table for ${draft.partySize} is confirmed at ${timeStr} under ${draft.customerName}. Is there anything else I can help you with?` };
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
    if (orderFlowActive && orderDraft.orderType && orderDraft.orderType !== "dineIn") {

      // Need items first
      if (orderDraft.items?.length === 0) {
        return { response: aiResponse || "What would you like to order?" };
      }

      // Delivery needs address
      if (orderDraft.orderType === "delivery" && !orderDraft.deliveryAddress) {
        return { response: aiResponse || "What is your delivery address?" };
      }

      // Need name
      if (!draft.customerName) {
        return { response: aiResponse || "What name should I put the order under?" };
      }

      // All collected — save
      const existing = await Order.findOne({ callId });
      if (existing) return { response: `Your order is already placed under ${draft.customerName}. Is there anything else I can help you with?` };

      const total = orderDraft.items.reduce((sum, item) => {
        const m = agent.menu?.find(m => m.name.toLowerCase() === item.name.toLowerCase());
        return sum + (m?.price || 0) * (item.quantity || 1);
      }, 0);

      await Order.create({
        callId, businessId: agent.businessId, agentId: agent._id,
        customerName: draft.customerName, customerPhone: draft.customerPhone || callerPhone,
        deliveryAddress: orderDraft.deliveryAddress || null,
        items: orderDraft.items.map(item => {
          const m = agent.menu?.find(m => m.name.toLowerCase() === item.name.toLowerCase());
          return { name: item.name, quantity: item.quantity || 1, price: m?.price || 0, extras: item.extras || [] };
        }),
        orderType: orderDraft.orderType, total, status: "confirmed",
      });

      await Call.updateOne({ _id: freshCall._id }, {
        $set: {
          "orderDraft.items": [], "orderDraft.orderType": null,
          "orderDraft.deliveryAddress": null, "orderDraft.status": "confirmed",
        },
      });

      console.log("✅ Order saved:", orderDraft.orderType);
      const itemsSummary = orderDraft.items.map(i => `${i.name} x${i.quantity || 1}`).join(", ");
      const msg = orderDraft.orderType === "delivery"
        ? `Perfect! Your order for ${itemsSummary} will be delivered to ${orderDraft.deliveryAddress} under ${draft.customerName}. Total is ${total} AED. Is there anything else I can help you with?`
        : `Perfect! Your order for ${itemsSummary} is ready for pickup under ${draft.customerName}. Total is ${total} AED. Is there anything else I can help you with?`;

      return { response: msg };
    }

    // Fallback — return AI response if we have one
    if (aiResponse) return { response: aiResponse };
    return { response: "How can I help you?" };
  }

  // ── GOODBYE ───────────────────────────────────────────────
  if (/\b(bye|goodbye|thank you|thanks|that's all|nothing else)\b/i.test(latestUserText)) {
    return { response: "Thank you for calling! Have a wonderful day. Goodbye!", end_call: true };
  }

  // ── GENERAL FALLBACK ──────────────────────────────────────
  const systemPrompt = buildSystemPrompt(agent);
  const history = transcript.slice(-6).map(t => ({
    role: t.role === "agent" ? "assistant" : "user",
    content: t.content,
  }));

  const aiReply = await getAIResponse([
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: latestUserText || "Hello" },
  ]);

  return { response: aiReply || "How can I help you today?" };
}

module.exports = { processLLMMessage };