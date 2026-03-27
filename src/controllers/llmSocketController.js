// src/controllers/llmSocketController.js

const Agent = require("../models/Agent");
const Call = require("../models/Call");
const Booking = require("../models/Booking");
const Order = require("../models/Order");
const { getAIResponse } = require("../services/aiChatService");
const { findNearestAvailableSlot } = require("../services/bookingService");

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
- NEVER ask party size or time for pickup or delivery orders
- If asked about something not on the menu, politely say it is not available
- Always be warm and welcoming`;
}

async function extractAndRespond(text, currentDraft, orderDraft, transcript, agent) {
  if (!text || text.trim().length < 1) return { extracted: {}, orderExtracted: {}, response: null };

  const hasOrders = agent.features?.orders === true;
  const hasBookings = agent.features?.bookings !== false;

  const recentConvo = (transcript ?? [])
    .slice(-4)
    .map(t => `${t.role === "agent" ? "Agent" : "Customer"}: ${t.content}`)
    .join("\n");

  const menuText = hasOrders && agent.menu?.length > 0
    ? `Available menu:\n${formatMenu(agent.menu)}`
    : "";

  const prompt = `You are a receptionist at ${agent.businessName}.

Current state:
- Booking: partySize=${currentDraft.partySize ?? "not collected"}, time=${currentDraft.requestedStart ? new Date(currentDraft.requestedStart).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:true}) : "not collected"}, name=${currentDraft.customerName ?? "not collected"}
- Order: items=${orderDraft.items?.length > 0 ? orderDraft.items.map(i=>`${i.name}x${i.quantity}`).join(",") : "none"}, type=${orderDraft.orderType ?? "not set"}, address=${orderDraft.deliveryAddress ?? "not collected"}

${menuText}

Recent conversation:
${recentConvo}

Customer just said: "${text}"

STRICT RULES:
- NEVER assume orderType. Only set orderType if customer explicitly says dineIn, pickup, or delivery. If customer just says "I want to order" without specifying, ask "Would you like delivery, pickup, or dine-in?"
- For pickup: collect items first, then name. Never ask for address or party size.
- For delivery: collect items first, then address (word for word), then name. Never ask for party size.
- For dineIn: collect items, party size, time, and name.
- Never ask for phone number or date.
- Keep responses short and warm.
- If customer corrects their name, use the corrected name.
- If all required info collected, return null for response.

Respond ONLY with this JSON (no markdown):
{
  "extracted": {
    "partySize": <number or null>,
    "time": "<HH:MM 24hr or null>",
    "name": "<string or null>"
  },
  "orderExtracted": {
    "items": [{"name": "<exact menu item name>", "quantity": <number>, "extras": []}],
    "orderType": "<dineIn|pickup|delivery|null>",
    "deliveryAddress": "<exact address as spoken or null>"
  },
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

    console.log("🎯 Combined extraction + response:", parsed);
    return {
      extracted: parsed.extracted ?? {},
      orderExtracted: parsed.orderExtracted ?? {},
      response: parsed.response ?? null,
    };

  } catch (err) {
    console.error("❌ OpenAI combined error:", err.message);
    return { extracted: {}, orderExtracted: {}, response: null };
  }
}

function looksLikeBookingIntent(text) {
  if (!text) return false;
  return /\b(book|reserve|reservation|table)\b/i.test(text);
}

function looksLikeOrderIntent(text) {
  if (!text) return false;
  return /\b(order|food|eat|hungry|menu|delivery|pickup|take.?away|bring|want to eat)\b/i.test(text);
}

const processingCalls = new Set();

async function processLLMMessage(body, req) {
  console.log("🎯 WEBSOCKET LLM CONTROLLER HIT");

  const interactionType = body.interaction_type || body.type;
  if (interactionType === "ping_pong") return null;
  if (interactionType !== "response_required") return null;

  // ── CALL ID ──────────────────────────────────────────────
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

  // ── SINGLE DB QUERY ──────────────────────────────────────
  const freshCall = await Call.findOne({
    $or: [{ callId }, { call_id: callId }],
  }).lean();

  if (!freshCall) {
    console.warn("⚠️ Call not found:", callId);
    return { response: "Sorry, something went wrong." };
  }

  // ── LOAD AGENT ───────────────────────────────────────────
  const agent = await Agent.findById(freshCall.agentId).lean();
  if (!agent) {
    console.warn("⚠️ Agent not found for call:", callId);
    return { response: "Sorry, something went wrong." };
  }

  // ── PHONE NUMBER ─────────────────────────────────────────
  const phoneFromBody =
    body?.call?.from_number ||
    body?.call?.caller_id ||
    body?.call?.from ||
    body?.call?.customer_number ||
    body?.from_number ||
    null;

  if (!freshCall.callerNumber && phoneFromBody) {
    await Call.updateOne(
      { _id: freshCall._id },
      { $set: { callerNumber: phoneFromBody } }
    );
  }

  const callerPhone = freshCall.callerNumber || phoneFromBody || null;

  // ── USER TEXT ────────────────────────────────────────────
  const latestUserText =
    typeof body.latest_user_text === "string"
      ? body.latest_user_text.trim()
      : "";

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

  // ── ORDER ALREADY CONFIRMED ───────────────────────────────
  if (orderDraft.status === "confirmed") {
    if (/\b(bye|goodbye|bye bye|thank you|thanks|that's all|nothing else|no thank)\b/i.test(latestUserText)) {
      return { response: "Thank you for calling! Have a wonderful day. Goodbye!", end_call: true };
    }
    // Reset if they want something new
    if (looksLikeBookingIntent(latestUserText) || looksLikeOrderIntent(latestUserText)) {
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
  const recentTranscriptText = transcript.slice(-4).map(t => t.content).join(" ");

  const bookingFlowActive =
    !!draft.partySize ||
    !!draft.requestedStart ||
    !!draft.customerName ||
    looksLikeBookingIntent(latestUserText) ||
    looksLikeBookingIntent(recentTranscriptText);

  const orderFlowActive =
    agent.features?.orders === true && (
      !!orderDraft.items?.length ||
      !!orderDraft.orderType ||
      looksLikeOrderIntent(latestUserText) ||
      looksLikeOrderIntent(recentTranscriptText)
    );

  // ── ACTIVE FLOW ───────────────────────────────────────────
  if (bookingFlowActive || orderFlowActive) {

    // Goodbye check first
    if (/\b(bye|goodbye|bye bye|thank you|thanks|that's all|nothing else|no thank)\b/i.test(latestUserText)) {
      return { response: "Thank you for calling! Have a wonderful day. Goodbye!", end_call: true };
    }

    const { extracted, orderExtracted, response: aiResponse } =
      await extractAndRespond(latestUserText, draft, orderDraft, transcript, agent);

    console.log("🧠 Extracted:", extracted);
    console.log("🛒 Order extracted:", orderExtracted);

    // Update booking draft fields
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
    // Always update name if AI extracted one (allows corrections)
    if (extracted.name) {
      draft.customerName = extracted.name;
    }

    // Update order draft — normalize and deduplicate items
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
        const exists = orderDraft.items.some(
          e => e.name.toLowerCase() === newItem.name.toLowerCase()
        );
        if (!exists) orderDraft.items.push(newItem);
      }
    }

    // Only update orderType if not already set, UNLESS customer is changing it
    if (orderExtracted.orderType) {
      orderDraft.orderType = orderExtracted.orderType;
    }

    // Always update delivery address if provided
    if (orderExtracted.deliveryAddress) {
      orderDraft.deliveryAddress = orderExtracted.deliveryAddress;
    }

    // Save drafts to MongoDB
    await Call.updateOne(
      { _id: freshCall._id },
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
    );

    console.log("📋 Booking draft:", draft);
    console.log("🛒 Order draft:", orderDraft);

    // ── CHECK WHAT IS COMPLETE ────────────────────────────
    const bookingComplete =
      bookingFlowActive && !orderFlowActive &&
      draft.partySize && draft.requestedStart && draft.customerName;

    const dineInComplete =
      orderDraft.orderType === "dineIn" &&
      orderDraft.items?.length > 0 &&
      draft.partySize && draft.requestedStart && draft.customerName;

    const pickupComplete =
      orderDraft.orderType === "pickup" &&
      orderDraft.items?.length > 0 &&
      draft.customerName;

    const deliveryComplete =
      orderDraft.orderType === "delivery" &&
      orderDraft.items?.length > 0 &&
      orderDraft.deliveryAddress &&
      draft.customerName;

    // Only return AI response if nothing is ready to save yet
    if (aiResponse && !bookingComplete && !dineInComplete && !pickupComplete && !deliveryComplete) {
      return { response: aiResponse };
    }

    // ── DINE-IN: SAVE ORDER + BOOKING ────────────────────
    if (dineInComplete) {
      if (processingCalls.has(callId)) return { response: "One moment please..." };
      processingCalls.add(callId);

      try {
        const existingOrder = await Order.findOne({ callId });
        if (existingOrder) {
          return { response: `Your order and table are already confirmed under ${draft.customerName}. Is there anything else I can help you with?` };
        }

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
          const total = orderDraft.items.reduce((sum, item) => {
            const menuItem = agent.menu?.find(m => m.name.toLowerCase() === item.name.toLowerCase());
            return sum + (menuItem?.price || 0) * (item.quantity || 1);
          }, 0);

          await Order.create({
            callId,
            businessId:    agent.businessId,
            agentId:       agent._id,
            customerName:  draft.customerName,
            customerPhone: draft.customerPhone || callerPhone,
            items: orderDraft.items.map(item => {
              const menuItem = agent.menu?.find(m => m.name.toLowerCase() === item.name.toLowerCase());
              return { name: item.name, quantity: item.quantity || 1, price: menuItem?.price || 0, extras: item.extras || [] };
            }),
            orderType: "dineIn",
            total,
            status: "confirmed",
          });

          await Call.updateOne({ _id: freshCall._id }, {
            $set: {
              "bookingDraft.partySize":      null,
              "bookingDraft.requestedStart": null,
              "bookingDraft.customerName":   null,
              "orderDraft.items":            [],
              "orderDraft.orderType":        null,
              "orderDraft.deliveryAddress":  null,
              "orderDraft.status":           "confirmed",
            },
          });

          const timeString = new Date(result.booking.startIso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
          const itemsSummary = orderDraft.items.map(i => `${i.name} x${i.quantity || 1}`).join(", ");
          console.log("✅ Dine-in order + booking confirmed");
          return { response: `Perfect! Your table for ${draft.partySize} is booked at ${timeString} under ${draft.customerName}, and your ${itemsSummary} will be ready when you arrive. Total is ${total} AED. Is there anything else I can help you with?` };
        }

        if (result?.suggestedTime) {
          const suggested = new Date(result.suggestedTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
          return { response: `We're fully booked at that time. Would ${suggested} work for you instead?` };
        }

        return { response: "I'm sorry, we don't have availability for that time. Would you like to try a different time?" };

      } catch (err) {
        console.error("❌ Dine-in error:", err.message);
        return { response: "I'm sorry, something went wrong. Please try again." };
      } finally {
        processingCalls.delete(callId);
      }
    }

    // ── BOOKING ONLY ──────────────────────────────────────
    if (bookingComplete) {
      const existingBooking = await Booking.findOne({ callId, status: { $in: ["confirmed", "seated"] } });
      if (existingBooking) {
        return { response: `Your reservation is already confirmed under ${draft.customerName}. Is there anything else I can help you with?` };
      }

      if (processingCalls.has(callId)) return { response: "One moment please..." };
      processingCalls.add(callId);

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
          await Call.updateOne({ _id: freshCall._id }, {
            $set: {
              "bookingDraft.partySize":      null,
              "bookingDraft.requestedStart": null,
              "bookingDraft.customerName":   null,
            },
          });

          const timeString = new Date(result.booking.startIso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
          console.log("✅ Booking confirmed");
          return { response: `Perfect! Your table for ${draft.partySize} is confirmed at ${timeString} under ${draft.customerName}. Is there anything else I can help you with?` };
        }

        if (result?.suggestedTime) {
          const suggested = new Date(result.suggestedTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
          return { response: `We're fully booked at that time. Would ${suggested} work for you instead?` };
        }

        return { response: "I'm sorry, we don't have availability for that time. Would you like to try a different time?" };

      } catch (err) {
        console.error("❌ Booking error:", err.message);
        return { response: "I'm sorry, something went wrong. Please try again." };
      } finally {
        processingCalls.delete(callId);
      }
    }

    // ── PICKUP OR DELIVERY ────────────────────────────────
    if (pickupComplete || deliveryComplete) {
      const existingOrder = await Order.findOne({ callId });
      if (existingOrder) {
        return { response: `Your order is already placed under ${draft.customerName}. Is there anything else I can help you with?` };
      }

      const total = orderDraft.items.reduce((sum, item) => {
        const menuItem = agent.menu?.find(m => m.name.toLowerCase() === item.name.toLowerCase());
        return sum + (menuItem?.price || 0) * (item.quantity || 1);
      }, 0);

      await Order.create({
        callId,
        businessId:      agent.businessId,
        agentId:         agent._id,
        customerName:    draft.customerName,
        customerPhone:   draft.customerPhone || callerPhone,
        deliveryAddress: orderDraft.deliveryAddress || null,
        items: orderDraft.items.map(item => {
          const menuItem = agent.menu?.find(m => m.name.toLowerCase() === item.name.toLowerCase());
          return { name: item.name, quantity: item.quantity || 1, price: menuItem?.price || 0, extras: item.extras || [] };
        }),
        orderType: orderDraft.orderType,
        total,
        status: "confirmed",
      });

      await Call.updateOne({ _id: freshCall._id }, {
        $set: {
          "orderDraft.items":           [],
          "orderDraft.orderType":       null,
          "orderDraft.deliveryAddress": null,
          "orderDraft.status":          "confirmed",
        },
      });

      console.log("✅ Order saved:", orderDraft.orderType);

      const itemsSummary = orderDraft.items.map(i => `${i.name} x${i.quantity || 1}`).join(", ");
      const confirmMsg = orderDraft.orderType === "delivery"
        ? `Perfect! Your order for ${itemsSummary} will be delivered to ${orderDraft.deliveryAddress} under ${draft.customerName}. Total is ${total} AED. Is there anything else I can help you with?`
        : `Perfect! Your order for ${itemsSummary} is ready for pickup under ${draft.customerName}. Total is ${total} AED. Is there anything else I can help you with?`;

      return { response: confirmMsg };
    }

    // Fallback — still collecting info
    return { response: aiResponse || "How can I help you?" };
  }

  // ── GOODBYE ───────────────────────────────────────────────
  if (/\b(bye|goodbye|thank you|thanks|that's all|nothing else|no thank|bye bye)\b/i.test(latestUserText)) {
    return { response: "Thank you for calling! Have a wonderful day. Goodbye!", end_call: true };
  }

  // ── GENERAL FALLBACK ──────────────────────────────────────
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