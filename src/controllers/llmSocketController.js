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
- NEVER ask party size — instead say "for how many people?"
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

  const returningInfo = returningContext
    ? `Returning customer context: ${returningContext}`
    : "";

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
- NEVER assume orderType. If customer just says "I want to order" ask "Would you like delivery, pickup, or dine-in?"
- For pickup: collect items first, then name. NEVER ask address or party size.
- For delivery: collect items first, then address, then name. NEVER ask party size.
- For dineIn: collect items, how many people, time, and name.
- NEVER say "party size" — say "how many people" instead.
- Never ask for phone number or date.
- Keep responses short and warm.
- If customer corrects their name, use the corrected name.
- For delivery address: extract ONLY the meaningful location info. Remove filler words like "uh", "um", "it's in", "the building name is", "located at". Format cleanly as: [Building/Landmark], [Street], [Notes].
- If customer wants to CANCEL booking or order, set intent to "cancel".
- If customer wants to MODIFY booking (time/people) or order (quantity/items/address/type), set intent to "modify".
- If all required info collected for new order/booking, return null for response.

Respond ONLY with valid JSON (no markdown):
{
  "extracted": {
    "partySize": <number or null>,
    "time": "<HH:MM 24hr or null>",
    "name": "<string or null>"
  },
  "orderExtracted": {
    "items": [{"name": "<exact menu item name>", "quantity": <number>, "extras": []}],
    "orderType": "<dineIn|pickup|delivery|null>",
    "deliveryAddress": "<cleaned address or null>"
  },
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

// ─── LOCK ─────────────────────────────────────────────────────────────────────

const processingCalls = new Set();

// ─── MAIN ────────────────────────────────────────────────────────────────────

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
    const last = parts[parts.length - 1];
    if (last?.startsWith("call_")) callId = last;
  }

  if (!callId) {
    console.warn("⚠️ No callId");
    return { response: "Sorry, something went wrong." };
  }

  // ── LOAD CALL ────────────────────────────────────────────
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
    console.warn("⚠️ Agent not found");
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

  const callerPhone = freshCall.callerNumber || phoneFromBody || null;

  if (!freshCall.callerNumber && phoneFromBody) {
    await Call.updateOne(
      { _id: freshCall._id },
      { $set: { callerNumber: phoneFromBody } }
    );
  }

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

  // ── RETURNING CALLER CHECK ───────────────────────────────
  // Only run once per call (when draft is empty and no name yet)
  let returningContext = null;
  let returningBooking = null;
  let returningOrder = null;
  let awaitingReturnConfirmation = freshCall.meta?.awaitingReturnConfirmation ?? false;
  let returnConfirmed = freshCall.meta?.returnConfirmed ?? false;

  if (callerPhone && !draft.customerName && !awaitingReturnConfirmation && !returnConfirmed) {
    // Find the most recent previous call from this phone number (not this call)
    const previousCall = await Call.findOne({
      _id: { $ne: freshCall._id },
      $or: [
        { callerNumber: callerPhone },
        { "bookingDraft.customerPhone": callerPhone },
      ],
      agentId: freshCall.agentId,
    }).sort({ createdAt: -1 }).lean();

    if (previousCall) {
      // Check for booking from that call
      const prevBooking = await Booking.findOne({
        callId: previousCall.callId,
        status: { $in: ["confirmed", "seated"] },
      }).lean();

      // Check for order from that call
      const prevOrder = await Order.findOne({
        callId: previousCall.callId,
        status: { $in: ["confirmed", "preparing", "ready"] },
      }).lean();

      // Use whichever is most recent
      if (prevBooking || prevOrder) {
        const name = prevBooking?.customerName || prevOrder?.customerName;
        if (name) {
          returningBooking = prevBooking;
          returningOrder = prevOrder;

          // Build context string
          if (prevBooking) {
            const timeStr = new Date(prevBooking.startTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
            returningContext = `Booking for ${prevBooking.partySize} people at ${timeStr} under ${name}`;
          } else if (prevOrder) {
            const itemsSummary = prevOrder.items.map(i => `${i.name} x${i.quantity}`).join(", ");
            returningContext = `${prevOrder.orderType} order: ${itemsSummary} under ${name}`;
          }

          // Mark as awaiting confirmation
          await Call.updateOne(
            { _id: freshCall._id },
            {
              $set: {
                "meta.awaitingReturnConfirmation": true,
                "meta.returningName": name,
                "meta.returningBookingId": prevBooking?._id?.toString() ?? null,
                "meta.returningOrderId": prevOrder?._id?.toString() ?? null,
              }
            }
          );

          console.log(`📞 Returning caller detected: ${name}`);
          return { response: `${name}? Is that right?` };
        }
      }
    }
  }

  // ── HANDLE RETURNING CALLER CONFIRMATION ─────────────────
  if (awaitingReturnConfirmation && !returnConfirmed) {
    const isYes = /\b(yes|yeah|yep|correct|that's me|right|yup|sure|exactly|affirmative)\b/i.test(latestUserText);
    const isNo = /\b(no|nope|wrong|not me|different|incorrect)\b/i.test(latestUserText);

    if (isYes) {
      const returningName = freshCall.meta?.returningName;
      const returningBookingId = freshCall.meta?.returningBookingId;
      const returningOrderId = freshCall.meta?.returningOrderId;

      // Set name in draft
      draft.customerName = returningName;
      await Call.updateOne(
        { _id: freshCall._id },
        {
          $set: {
            "meta.returnConfirmed": true,
            "meta.awaitingReturnConfirmation": false,
            "bookingDraft.customerName": returningName,
          }
        }
      );

      // Load the returning booking/order for context
      let contextMsg = "";
      if (returningBookingId) {
        returningBooking = await Booking.findById(returningBookingId).lean();
        if (returningBooking) {
          const timeStr = new Date(returningBooking.startTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
          contextMsg = `I have your table booking for ${returningBooking.partySize} at ${timeStr}.`;
        }
      }
      if (!contextMsg && returningOrderId) {
        returningOrder = await Order.findById(returningOrderId).lean();
        if (returningOrder) {
          const itemsSummary = returningOrder.items.map(i => `${i.name} x${i.quantity}`).join(", ");
          contextMsg = `I have your ${returningOrder.orderType} order for ${itemsSummary}.`;
        }
      }

      return { response: `Great! ${contextMsg} How can I help you?` };
    }

    if (isNo) {
      await Call.updateOne(
        { _id: freshCall._id },
        {
          $set: {
            "meta.awaitingReturnConfirmation": false,
            "meta.returnConfirmed": false,
          }
        }
      );
      return { response: "I'm sorry about that! How can I help you today?" };
    }

    // Not yes/no yet — re-ask
    return { response: `Sorry, I didn't catch that. Is this ${freshCall.meta?.returningName}?` };
  }

  // ── LOAD RETURNING IDs IF CONFIRMED ──────────────────────
  const confirmedBookingId = freshCall.meta?.returningBookingId ?? null;
  const confirmedOrderId = freshCall.meta?.returningOrderId ?? null;
  returnConfirmed = freshCall.meta?.returnConfirmed ?? false;

  // ── INTENT DETECTION ─────────────────────────────────────
  const recentTranscriptText = transcript.slice(-4).map(t => t.content).join(" ");

  const cancelIntent = looksLikeCancelIntent(latestUserText);
  const modifyIntent = looksLikeModifyIntent(latestUserText);

  const bookingFlowActive =
    !!draft.partySize ||
    !!draft.requestedStart ||
    (!returnConfirmed && !!draft.customerName) ||
    looksLikeBookingIntent(latestUserText) ||
    looksLikeBookingIntent(recentTranscriptText);

  const orderFlowActive =
    agent.features?.orders === true && (
      !!orderDraft.items?.length ||
      !!orderDraft.orderType ||
      looksLikeOrderIntent(latestUserText) ||
      looksLikeOrderIntent(recentTranscriptText)
    );

  // ── CANCEL FLOW ───────────────────────────────────────────
  if (cancelIntent && returnConfirmed) {
    const bookingIdToCancel = confirmedBookingId;
    const orderIdToCancel = confirmedOrderId;

    // Determine what to cancel based on context
    const wantsToCancel = latestUserText.toLowerCase();

    // Cancel booking
    if (bookingIdToCancel && (wantsToCancel.includes("book") || wantsToCancel.includes("reserv") || wantsToCancel.includes("table") || !wantsToCancel.includes("order"))) {
      const booking = await Booking.findById(bookingIdToCancel);
      if (booking) {
        await Booking.updateOne({ _id: bookingIdToCancel }, { $set: { status: "cancelled" } });
        await Call.updateOne({ _id: freshCall._id }, {
          $set: {
            "meta.returningBookingId": null,
            "bookingDraft.partySize": null,
            "bookingDraft.requestedStart": null,
            "bookingDraft.customerName": null,
          }
        });
        console.log("✅ Booking cancelled:", bookingIdToCancel);
        return { response: `Done! Your booking has been cancelled. Is there anything else I can help you with?` };
      }
    }

    // Cancel order
    if (orderIdToCancel) {
      const order = await Order.findById(orderIdToCancel);
      if (order) {
        const minutesSincePlaced = (Date.now() - new Date(order.createdAt).getTime()) / 60000;
        if (minutesSincePlaced > 5) {
          return { response: `I'm sorry, your order was placed ${Math.floor(minutesSincePlaced)} minutes ago and is likely already being prepared. It cannot be cancelled.` };
        }
        await Order.updateOne({ _id: orderIdToCancel }, { $set: { status: "cancelled" } });
        await Call.updateOne({ _id: freshCall._id }, {
          $set: {
            "meta.returningOrderId": null,
            "orderDraft.items": [],
            "orderDraft.orderType": null,
            "orderDraft.status": null,
            "orderDraft.deliveryAddress": null,
          }
        });
        console.log("✅ Order cancelled:", orderIdToCancel);
        return { response: `Done! Your order has been cancelled. Is there anything else I can help you with?` };
      }
    }
  }

  // Also handle cancel during same call (order just placed this call)
  if (cancelIntent && orderDraft.status === "confirmed") {
    const existingOrder = await Order.findOne({ callId });
    if (existingOrder) {
      const minutesSincePlaced = (Date.now() - new Date(existingOrder.createdAt).getTime()) / 60000;
      if (minutesSincePlaced > 5) {
        return { response: `I'm sorry, your order was placed ${Math.floor(minutesSincePlaced)} minutes ago and is likely already being prepared. It cannot be cancelled.` };
      }
      await Order.updateOne({ _id: existingOrder._id }, { $set: { status: "cancelled" } });
      await Call.updateOne({ _id: freshCall._id }, {
        $set: {
          "orderDraft.items": [],
          "orderDraft.orderType": null,
          "orderDraft.status": "cancelled",
          "orderDraft.deliveryAddress": null,
        }
      });
      return { response: "Done! Your order has been cancelled. Is there anything else I can help you with?" };
    }
  }

  // Cancel booking during same call
  if (cancelIntent && (bookingFlowActive || looksLikeBookingIntent(latestUserText))) {
    const existingBooking = await Booking.findOne({ callId, status: { $in: ["confirmed","seated"] } });
    if (existingBooking) {
      await Booking.updateOne({ _id: existingBooking._id }, { $set: { status: "cancelled" } });
      await Call.updateOne({ _id: freshCall._id }, {
        $set: {
          "bookingDraft.partySize": null,
          "bookingDraft.requestedStart": null,
          "bookingDraft.customerName": null,
        }
      });
      return { response: "Done! Your booking has been cancelled. Is there anything else I can help you with?" };
    }
  }

  // ── MODIFY FLOW (returning caller) ───────────────────────
  if (modifyIntent && returnConfirmed && (confirmedBookingId || confirmedOrderId)) {
    // Load what we're modifying
    if (confirmedOrderId && (
      latestUserText.toLowerCase().includes("order") ||
      latestUserText.toLowerCase().includes("chicken") ||
      latestUserText.toLowerCase().includes("quantity") ||
      latestUserText.toLowerCase().includes("make it") ||
      latestUserText.toLowerCase().includes("change it")
    )) {
      const existingOrder = await Order.findById(confirmedOrderId);
      if (existingOrder) {
        const minutesSincePlaced = (Date.now() - new Date(existingOrder.createdAt).getTime()) / 60000;
        if (minutesSincePlaced > 5) {
          return { response: `I'm sorry, your order was placed ${Math.floor(minutesSincePlaced)} minutes ago and cannot be modified.` };
        }
        // Load order into draft so the flow can update it
        orderDraft.items = existingOrder.items;
        orderDraft.orderType = existingOrder.orderType;
        orderDraft.deliveryAddress = existingOrder.deliveryAddress;
        orderDraft.status = null; // allow modification
        await Call.updateOne({ _id: freshCall._id }, {
          $set: {
            "orderDraft.items": existingOrder.items,
            "orderDraft.orderType": existingOrder.orderType,
            "orderDraft.deliveryAddress": existingOrder.deliveryAddress,
            "orderDraft.status": null,
          }
        });
      }
    }
  }

  // ── ORDER CONFIRMED THIS CALL — handle modification ───────
  if (orderDraft.status === "confirmed") {
    if (/\b(bye|goodbye|bye bye|thank you|thanks|that's all|nothing else|no thank)\b/i.test(latestUserText)) {
      return { response: "Thank you for calling! Have a wonderful day. Goodbye!", end_call: true };
    }

    // Allow modification within 5 minutes
    if (modifyIntent || looksLikeOrderIntent(latestUserText)) {
      const existingOrder = await Order.findOne({ callId });
      if (existingOrder) {
        const minutesSincePlaced = (Date.now() - new Date(existingOrder.createdAt).getTime()) / 60000;
        if (minutesSincePlaced > 5) {
          return { response: `I'm sorry, your order was placed ${Math.floor(minutesSincePlaced)} minutes ago and cannot be modified.` };
        }
        // Load into draft for modification
        orderDraft.items = existingOrder.items;
        orderDraft.orderType = existingOrder.orderType;
        orderDraft.deliveryAddress = existingOrder.deliveryAddress;
        orderDraft.status = null;
        await Call.updateOne({ _id: freshCall._id }, {
          $set: {
            "orderDraft.items": existingOrder.items,
            "orderDraft.orderType": existingOrder.orderType,
            "orderDraft.deliveryAddress": existingOrder.deliveryAddress,
            "orderDraft.status": null,
          }
        });
      }
    } else if (looksLikeBookingIntent(latestUserText)) {
      // They want to book a table after ordering
      // fall through to booking flow below
    } else {
      return { response: "Is there anything else I can help you with?" };
    }
  }

  // ── ACTIVE FLOW ───────────────────────────────────────────
  if (bookingFlowActive || orderFlowActive || cancelIntent || modifyIntent) {

    // Goodbye check
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

    // Update order items — allow quantity updates
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
        const existingIndex = orderDraft.items.findIndex(
          e => e.name.toLowerCase() === newItem.name.toLowerCase()
        );
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

    // ── COMPLETION CHECKS ─────────────────────────────────
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

    // Return AI response if nothing complete yet
    if (aiResponse && !bookingComplete && !dineInComplete && !pickupComplete && !deliveryComplete) {
      return { response: aiResponse };
    }

    // ── DINE-IN: SAVE/UPDATE ORDER + BOOKING ─────────────
    if (dineInComplete) {
      if (processingCalls.has(callId)) return { response: "One moment please..." };
      processingCalls.add(callId);

      try {
        const existingOrder = await Order.findOne({ callId });

        const total = orderDraft.items.reduce((sum, item) => {
          const menuItem = agent.menu?.find(m => m.name.toLowerCase() === item.name.toLowerCase());
          return sum + (menuItem?.price || 0) * (item.quantity || 1);
        }, 0);

        const orderItems = orderDraft.items.map(item => {
          const menuItem = agent.menu?.find(m => m.name.toLowerCase() === item.name.toLowerCase());
          return { name: item.name, quantity: item.quantity || 1, price: menuItem?.price || 0, extras: item.extras || [] };
        });

        if (existingOrder) {
          await Order.updateOne({ _id: existingOrder._id }, {
            $set: { items: orderItems, total, status: "confirmed" }
          });
        }

        const existingBooking = await Booking.findOne({ callId, status: { $in: ["confirmed","seated"] } });

        const result = existingBooking
          ? { success: true, booking: { startIso: existingBooking.startTime } }
          : await findNearestAvailableSlot({
              businessId: agent.businessId, requestedStart: draft.requestedStart,
              durationMinutes: 90, partySize: draft.partySize, source: "ai",
              agentId: agent._id, callId, customerName: draft.customerName, customerPhone: draft.customerPhone,
            });

        if (existingBooking) {
          await Booking.updateOne({ _id: existingBooking._id }, {
            $set: { partySize: draft.partySize, startTime: draft.requestedStart }
          });
        }

        if (result?.success) {
          if (!existingOrder) {
            await Order.create({
              callId, businessId: agent.businessId, agentId: agent._id,
              customerName: draft.customerName, customerPhone: draft.customerPhone || callerPhone,
              items: orderItems, orderType: "dineIn", total, status: "confirmed",
            });
          }

          await Call.updateOne({ _id: freshCall._id }, {
            $set: {
              "bookingDraft.partySize": null, "bookingDraft.requestedStart": null, "bookingDraft.customerName": null,
              "orderDraft.items": [], "orderDraft.orderType": null,
              "orderDraft.deliveryAddress": null, "orderDraft.status": "confirmed",
            },
          });

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
        // Check for existing booking this call or from returning caller
        const existingBooking = await Booking.findOne({
          $or: [
            { callId, status: { $in: ["confirmed","seated"] } },
            ...(confirmedBookingId ? [{ _id: confirmedBookingId }] : []),
          ]
        });

        if (existingBooking) {
          // Modify existing booking
          await Booking.updateOne({ _id: existingBooking._id }, {
            $set: {
              partySize: draft.partySize,
              startTime: draft.requestedStart,
              customerName: draft.customerName,
            }
          });
          await Call.updateOne({ _id: freshCall._id }, {
            $set: {
              "bookingDraft.partySize": null,
              "bookingDraft.requestedStart": null,
              "bookingDraft.customerName": null,
            }
          });
          const timeString = new Date(draft.requestedStart).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
          console.log("✅ Booking updated");
          return { response: `Done! Your booking has been updated to ${draft.partySize} people at ${timeString} under ${draft.customerName}. Is there anything else I can help you with?` };
        }

        const result = await findNearestAvailableSlot({
          businessId: agent.businessId, requestedStart: draft.requestedStart,
          durationMinutes: 90, partySize: draft.partySize, source: "ai",
          agentId: agent._id, callId, customerName: draft.customerName, customerPhone: draft.customerPhone,
        });

        if (result?.success && result.booking) {
          await Call.updateOne({ _id: freshCall._id }, {
            $set: {
              "bookingDraft.partySize": null,
              "bookingDraft.requestedStart": null,
              "bookingDraft.customerName": null,
            }
          });
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
      // Check for existing order to update (same call or returning caller)
      const existingOrder = await Order.findOne({
        $or: [
          { callId },
          ...(confirmedOrderId ? [{ _id: confirmedOrderId }] : []),
        ]
      });

      const total = orderDraft.items.reduce((sum, item) => {
        const menuItem = agent.menu?.find(m => m.name.toLowerCase() === item.name.toLowerCase());
        return sum + (menuItem?.price || 0) * (item.quantity || 1);
      }, 0);

      const orderItems = orderDraft.items.map(item => {
        const menuItem = agent.menu?.find(m => m.name.toLowerCase() === item.name.toLowerCase());
        return { name: item.name, quantity: item.quantity || 1, price: menuItem?.price || 0, extras: item.extras || [] };
      });

      if (existingOrder) {
        // Update existing order
        await Order.updateOne({ _id: existingOrder._id }, {
          $set: {
            items: orderItems,
            deliveryAddress: orderDraft.deliveryAddress || existingOrder.deliveryAddress,
            orderType: orderDraft.orderType,
            customerName: draft.customerName,
            total,
            status: "confirmed",
          }
        });
        console.log("✅ Order updated:", orderDraft.orderType);
      } else {
        // Create new order
        await Order.create({
          callId,
          businessId:      agent.businessId,
          agentId:         agent._id,
          customerName:    draft.customerName,
          customerPhone:   draft.customerPhone || callerPhone,
          deliveryAddress: orderDraft.deliveryAddress || null,
          items:           orderItems,
          orderType:       orderDraft.orderType,
          total,
          status:          "confirmed",
        });
        console.log("✅ Order saved:", orderDraft.orderType);
      }

      await Call.updateOne({ _id: freshCall._id }, {
        $set: {
          "orderDraft.items":           [],
          "orderDraft.orderType":       null,
          "orderDraft.deliveryAddress": null,
          "orderDraft.status":          "confirmed",
        },
      });

      const itemsSummary = orderDraft.items.map(i => `${i.name} x${i.quantity || 1}`).join(", ");
      const confirmMsg = orderDraft.orderType === "delivery"
        ? `Perfect! Your order for ${itemsSummary} will be delivered to ${orderDraft.deliveryAddress} under ${draft.customerName}. Total is ${total} AED. Is there anything else I can help you with?`
        : `Perfect! Your order for ${itemsSummary} is ready for pickup under ${draft.customerName}. Total is ${total} AED. Is there anything else I can help you with?`;

      return { response: confirmMsg };
    }

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