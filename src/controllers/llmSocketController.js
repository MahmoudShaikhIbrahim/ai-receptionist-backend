// src/controllers/llmSocketController.js

const Agent = require("../models/Agent");
const Call = require("../models/Call");
const Booking = require("../models/Booking");
const Order = require("../models/Order");
const { getAIResponse } = require("../services/aiChatService");
const { findNearestAvailableSlot } = require("../services/bookingService");

/**
 * ================================
 * AGENT CACHE (reduces DB queries per message)
 * ================================
 */
const agentCache = new Map(); // agentId -> { agent, timestamp }
const AGENT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getCachedAgent(agentId) {
  const key = agentId.toString();
  const cached = agentCache.get(key);
  if (cached && Date.now() - cached.timestamp < AGENT_CACHE_TTL) {
    return cached.agent;
  }
  const agent = await Agent.findById(agentId).lean();
  if (agent) {
    agentCache.set(key, { agent, timestamp: Date.now() });
  }
  return agent;
}

/**
 * ================================
 * FORMAT MENU FOR AI
 * ================================
 */
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
        if (i.extras?.length) {
          line += ` (Extras: ${i.extras.map(e => `${e.name} +${e.price}`).join(", ")})`;
        }
        return line;
      });
      return `${cat}:\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

/**
 * ================================
 * FORMAT OPENING HOURS FOR AI
 * ================================
 */
function formatOpeningHours(openingHours) {
  if (!openingHours) return "Opening hours not set.";
  const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  return days.map(day => {
    const h = openingHours[day];
    if (!h || h.closed) return `${day.charAt(0).toUpperCase() + day.slice(1)}: Closed`;
    if (!h.open && !h.close) return `${day.charAt(0).toUpperCase() + day.slice(1)}: Hours not set`;
    return `${day.charAt(0).toUpperCase() + day.slice(1)}: ${h.open} - ${h.close}`;
  }).join("\n");
}

/**
 * ================================
 * BUILD SYSTEM PROMPT FROM AGENT
 * ================================
 */
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
- The customer has already been greeted. Do NOT greet them again or say "Hello" or "Welcome".
- Keep responses short and natural, suitable for a phone call
- Never ask for the customer's phone number
- Never mention dates for reservations, only times
- If asked about something not on the menu, politely say it is not available
- Always be warm and welcoming`;
}

/**
 * ================================
 * COMBINED AI EXTRACTION + RESPONSE
 * ================================
 */
async function extractAndRespond(text, currentDraft, orderDraft, transcript, agent, { bookingOnly = false } = {}) {
  if (!text || text.trim().length < 1) return { extracted: {}, orderExtracted: {}, response: null };

  const hasOrders = agent.features?.orders === true;
  const hasBookings = agent.features?.bookings !== false;
  const currentOrderType = orderDraft.orderType;

  const recentConvo = (transcript ?? [])
    .slice(-6)
    .map(t => `${t.role === "agent" ? "Agent" : "Customer"}: ${t.content}`)
    .join("\n");

  const menuText = !bookingOnly && hasOrders && agent.menu?.length > 0
    ? `Available menu:\n${formatMenu(agent.menu)}`
    : "";

  let prompt;

  if (bookingOnly) {
    // ── BOOKING-ONLY PROMPT ──────────────────────────────────────────────────
    // The customer wants to book a table. Do NOT mention orders at all.
    prompt = `You are ${agent.agentName || "an AI receptionist"} at ${agent.businessName}.

The customer wants to BOOK A TABLE. This is a reservation request only — do NOT ask about food orders, order type, dine-in, pickup, or delivery.

Current booking status:
- Party size: ${currentDraft.partySize ?? "not collected"}
- Time: ${currentDraft.requestedStart ? new Date(currentDraft.requestedStart).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }) : "not collected"}
- Name: ${currentDraft.customerName ?? "not collected"}

Recent conversation:
${recentConvo}

Customer just said: "${text}"

Your job:
1. Extract party size, time, and/or name if mentioned
2. Ask for the next missing piece (party size → time → name)
3. If all three are collected, return null for response

Rules:
- Do NOT greet the customer. They have already been greeted.
- Do NOT ask about food, orders, dine-in, pickup, or delivery.
- Never ask for phone number or date (only time/time-of-day)
- Ask for ONE thing at a time
- Keep response short and warm

Respond ONLY with this JSON:
{
  "extracted": {
    "partySize": <number or null>,
    "time": "<HH:MM or null>",
    "name": "<string or null>"
  },
  "orderExtracted": {
    "items": [],
    "orderType": null,
    "deliveryAddress": null
  },
  "response": "<your natural reply or null if all three collected>"
}

Only JSON. No markdown. No explanation.`;

  } else {
    // ── ORDER (or combined) PROMPT ───────────────────────────────────────────
    // Build order-type-specific collection rules
    let orderCollectionRules;
    if (currentOrderType === "pickup") {
      orderCollectionRules = `This is a PICKUP order. Collect ONLY the customer's name. Do NOT ask for party size, time, or delivery address.`;
    } else if (currentOrderType === "delivery") {
      orderCollectionRules = `This is a DELIVERY order. Collect delivery address and customer name ONLY. Do NOT ask for party size or time.`;
    } else if (currentOrderType === "dineIn") {
      orderCollectionRules = `This is a DINE-IN order. Collect party size, time, and customer name (same as a booking).`;
    } else {
      orderCollectionRules = `Order type not yet determined. Only ask for order type AFTER the customer has mentioned specific food items they want to order.`;
    }

    // Only show booking fields when relevant (dineIn or booking flow)
    const showBookingStatus = !currentOrderType || currentOrderType === "dineIn";

    prompt = `You are ${agent.agentName || "an AI receptionist"} at ${agent.businessName}.

${showBookingStatus ? `Current booking status:
- Party size: ${currentDraft.partySize ?? "not collected"}
- Time: ${currentDraft.requestedStart ? new Date(currentDraft.requestedStart).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }) : "not collected"}
- Name: ${currentDraft.customerName ?? "not collected"}
` : `Customer name: ${currentDraft.customerName ?? "not collected"}`}

Current order status:
- Items ordered: ${orderDraft.items?.length > 0 ? orderDraft.items.map(i => `${i.name} x${i.quantity}`).join(", ") : "none"}
- Order type: ${orderDraft.orderType ?? "not set"}
- Delivery address: ${orderDraft.deliveryAddress ?? "not collected"}

${menuText}

Recent conversation:
${recentConvo}

Customer just said: "${text}"

Your job:
1. Extract any booking info (party size, time, name) — only if applicable
2. Extract any order info (menu items, quantities, order type, delivery address)
3. Respond naturally to move the conversation forward

Features enabled:
- Bookings: ${hasBookings}
- Orders: ${hasOrders}

Rules:
- Do NOT greet the customer. They have already been greeted.
- Ask for ONE thing at a time
- Never ask for phone number or date
- Keep response short and warm like a real person on the phone
- For orders, only accept items that exist on the menu
- Order type can be: dineIn, pickup, or delivery
- ${orderCollectionRules}
- If all required info is collected, return null for response

Respond ONLY with this JSON:
{
  "extracted": {
    "partySize": <number or null>,
    "time": "<HH:MM or null>",
    "name": "<string or null>"
  },
  "orderExtracted": {
    "items": [{ "name": "<item name>", "quantity": <number>, "extras": ["<extra name>"] }],
    "orderType": "<dineIn|pickup|delivery|null>",
    "deliveryAddress": "<full address exactly as spoken or null>"
  },
  "response": "<your natural reply or null if everything collected>"
}

Only JSON. No markdown. No explanation.`;
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 300,
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

/**
 * ================================
 * INTENT DETECTION
 * ================================
 */
function looksLikeBookingIntent(text) {
  if (!text) return false;
  return /\b(book|reserve|reservation|table)\b/i.test(text);
}

function looksLikeOrderIntent(text) {
  if (!text) return false;
  return /\b(order|food|eat|hungry|menu|delivery|pickup|take.?away|bring|want to eat)\b/i.test(text);
}

function looksLikeFarewell(text) {
  if (!text) return false;
  return /\b(bye|goodbye|good night|see you|gotta go|that.?s all|nothing else|all good|have a good)\b/i.test(text);
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
   * CALL ID
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
   * LOAD CALL (single query with .lean() — no second query needed)
   */
  const call = await Call.findOne({
    $or: [{ callId }, { call_id: callId }],
  }).lean();

  if (!call) {
    console.warn("⚠️ Call not found:", callId);
    return { response: "Sorry, something went wrong." };
  }

  /**
   * LOAD AGENT (cached)
   */
  const agent = await getCachedAgent(call.agentId);
  if (!agent) {
    console.warn("⚠️ Agent not found for call:", callId);
    return { response: "Sorry, something went wrong." };
  }

  /**
   * PHONE NUMBER
   */
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
   * USER TEXT
   */
  const latestUserText =
    typeof body.latest_user_text === "string"
      ? body.latest_user_text.trim()
      : "";

  const transcript = body.transcript ?? [];

  /**
   * FAREWELL DETECTION — end call gracefully
   */
  if (looksLikeFarewell(latestUserText)) {
    // Clear any drafts so nothing lingers
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
    return {
      response: "You're welcome! Have a wonderful day. Goodbye!",
      end_call: true,
    };
  }

  /**
   * DRAFT STATE (use lean call document directly — no second DB query)
   */
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

  /**
   * INTENT DETECTION
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

  const orderFlowActive =
    agent.features?.orders === true && (
      !!orderDraft.items?.length ||
      !!orderDraft.orderType ||
      looksLikeOrderIntent(latestUserText) ||
      looksLikeOrderIntent(recentTranscriptText)
    );

  /**
   * ACTIVE FLOW
   */
  if (bookingFlowActive || orderFlowActive) {

    const { extracted, orderExtracted, response: aiResponse } =
      await extractAndRespond(latestUserText, draft, orderDraft, transcript, agent, {
        bookingOnly: bookingFlowActive && !orderFlowActive,
      });

    console.log("🧠 Extracted:", extracted);
    console.log("🛒 Order extracted:", orderExtracted);

    // Update booking draft
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

    // Update order draft — deduplicated
    if (orderExtracted.items?.length > 0) {
      const validItems = orderExtracted.items.filter(item =>
        agent.menu?.some(m => m.name.toLowerCase() === item.name.toLowerCase() && m.available)
      );
      for (const newItem of validItems) {
        const exists = orderDraft.items.some(
          existing => existing.name.toLowerCase() === newItem.name.toLowerCase()
        );
        if (!exists) {
          orderDraft.items.push(newItem);
        }
      }
    }
    if (orderExtracted.orderType) {
      orderDraft.orderType = orderExtracted.orderType;
    }
    // Always update address if AI extracted one (allows correction on re-statement)
    if (orderExtracted.deliveryAddress) {
      orderDraft.deliveryAddress = orderExtracted.deliveryAddress;
    }

    // Save drafts to MongoDB
    await Call.updateOne(
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
    );

    console.log("📋 Booking draft:", draft);
    console.log("🛒 Order draft:", orderDraft);

    // If AI still has a response, return it
    if (aiResponse) {
      return { response: aiResponse };
    }

    /**
     * ================================
     * DINE-IN ORDER → SAVE ORDER + BOOKING
     * ================================
     */
    if (
      orderFlowActive &&
      orderDraft.orderType === "dineIn" &&
      orderDraft.items?.length > 0 &&
      draft.partySize &&
      draft.requestedStart &&
      draft.customerName
    ) {
      if (processingCalls.has(callId)) {
        return { response: "One moment please..." };
      }
      processingCalls.add(callId);

      try {
        // Check for existing order
        const existingOrder = await Order.findOne({ callId });
        if (existingOrder) {
          // Order already saved — clear drafts and return farewell-friendly response
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
          return {
            response: `Your order and table are already confirmed under ${draft.customerName}. Is there anything else I can help you with?`,
          };
        }

        // Run booking engine
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
          // Calculate total
          const total = orderDraft.items.reduce((sum, item) => {
            const menuItem = agent.menu?.find(m => m.name.toLowerCase() === item.name.toLowerCase());
            return sum + (menuItem?.price || 0) * (item.quantity || 1);
          }, 0);

          // Save order
          await Order.create({
            callId,
            businessId:      agent.businessId,
            agentId:         agent._id,
            customerName:    draft.customerName,
            customerPhone:   draft.customerPhone || call.callerNumber,
            items: orderDraft.items.map(item => {
              const menuItem = agent.menu?.find(m => m.name.toLowerCase() === item.name.toLowerCase());
              return {
                name:     item.name,
                quantity: item.quantity || 1,
                price:    menuItem?.price || 0,
                extras:   item.extras || [],
              };
            }),
            orderType: "dineIn",
            total,
            status: "confirmed",
          });

          // Clear all drafts after confirmation
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

          const timeString = new Date(result.booking.startIso).toLocaleTimeString("en-US", {
            hour: "numeric", minute: "2-digit", hour12: true,
          });

          const itemsSummary = orderDraft.items.map(i => `${i.name} x${i.quantity || 1}`).join(", ");

          console.log("✅ Dine-in order + booking confirmed");
          return {
            response: `Perfect! Your table for ${draft.partySize} is booked at ${timeString} under ${draft.customerName}, and your ${itemsSummary} will be ready when you arrive. Total is ${total} AED. Is there anything else I can help you with?`,
          };
        }

        if (result?.suggestedTime) {
          const suggested = new Date(result.suggestedTime).toLocaleTimeString("en-US", {
            hour: "numeric", minute: "2-digit", hour12: true,
          });
          return {
            response: `We're fully booked at that time. Would ${suggested} work for you instead?`,
          };
        }

        return {
          response: "I'm sorry, we don't have availability for that time. Would you like to try a different time?",
        };

      } catch (err) {
        console.error("❌ Dine-in order error:", err.message);
        return {
          response: "I'm sorry, something went wrong. Please try again.",
        };
      } finally {
        processingCalls.delete(callId);
      }
    }

    /**
     * ================================
     * BOOKING ONLY (no order)
     * ================================
     */
    if (
      bookingFlowActive &&
      !orderFlowActive &&
      draft.partySize &&
      draft.requestedStart &&
      draft.customerName
    ) {
      const existingBooking = await Booking.findOne({
        callId,
        status: { $in: ["confirmed", "seated"] },
      });

      if (existingBooking) {
        // Already confirmed — clear drafts
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
        return {
          response: `Your reservation is already confirmed under ${draft.customerName}. Is there anything else I can help you with?`,
        };
      }

      if (processingCalls.has(callId)) {
        return { response: "One moment please..." };
      }
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

          const timeString = new Date(result.booking.startIso).toLocaleTimeString("en-US", {
            hour: "numeric", minute: "2-digit", hour12: true,
          });

          return {
            response: `Perfect! Your table for ${draft.partySize} is confirmed at ${timeString} under ${draft.customerName}. Is there anything else I can help you with?`,
          };
        }

        if (result?.suggestedTime) {
          const suggested = new Date(result.suggestedTime).toLocaleTimeString("en-US", {
            hour: "numeric", minute: "2-digit", hour12: true,
          });
          return {
            response: `We're fully booked at that time. Would ${suggested} work for you instead?`,
          };
        }

        return {
          response: "I'm sorry, we don't have availability for that time. Would you like to try a different time?",
        };

      } catch (err) {
        console.error("❌ Booking error:", err.message);
        return {
          response: "I'm sorry, something went wrong while making the reservation. Please try again.",
        };
      } finally {
        processingCalls.delete(callId);
      }
    }

    /**
     * ================================
     * PICKUP OR DELIVERY ORDER
     * ================================
     */
    if (
      orderFlowActive &&
      orderDraft.items?.length > 0 &&
      orderDraft.orderType &&
      orderDraft.orderType !== "dineIn"
    ) {
      // For delivery, need address and name
      if (orderDraft.orderType === "delivery") {
        if (!orderDraft.deliveryAddress) {
          return { response: aiResponse || "What is your delivery address?" };
        }
        if (!draft.customerName) {
          return { response: aiResponse || "And what name should I put the order under?" };
        }
      }

      // For pickup, just need name
      if (orderDraft.orderType === "pickup" && !draft.customerName) {
        return { response: aiResponse || "What name should I put the order under?" };
      }

      // All info collected — save order
      const existingOrder = await Order.findOne({ callId });
      if (existingOrder) {
        // Already confirmed — clear drafts so we don't loop
        await Call.updateOne(
          { _id: call._id },
          {
            $set: {
              "orderDraft.items":           [],
              "orderDraft.orderType":       null,
              "orderDraft.deliveryAddress": null,
            },
          }
        );
        return {
          response: `Your order is already placed under ${draft.customerName || "your name"}. Is there anything else I can help you with?`,
        };
      }

      const total = orderDraft.items.reduce((sum, item) => {
        const menuItem = agent.menu?.find(m => m.name.toLowerCase() === item.name.toLowerCase());
        return sum + (menuItem?.price || 0) * (item.quantity || 1);
      }, 0);

      await Order.create({
        callId,
        businessId:      agent.businessId,
        agentId:         agent._id,
        customerName:    draft.customerName || "Guest",
        customerPhone:   draft.customerPhone || call.callerNumber,
        deliveryAddress: orderDraft.deliveryAddress || null,
        items: orderDraft.items.map(item => {
          const menuItem = agent.menu?.find(m => m.name.toLowerCase() === item.name.toLowerCase());
          return {
            name:     item.name,
            quantity: item.quantity || 1,
            price:    menuItem?.price || 0,
            extras:   item.extras || [],
          };
        }),
        orderType: orderDraft.orderType,
        total,
        status: "confirmed",
      });

      console.log("✅ Order saved:", orderDraft.orderType);

      // Clear order drafts after confirmation so the flow doesn't repeat
      await Call.updateOne(
        { _id: call._id },
        {
          $set: {
            "orderDraft.items":           [],
            "orderDraft.orderType":       null,
            "orderDraft.deliveryAddress": null,
          },
        }
      );

      const itemsSummary = orderDraft.items.map(i => `${i.name} x${i.quantity || 1}`).join(", ");

      const confirmMsg = orderDraft.orderType === "delivery"
        ? `Perfect! Your order for ${itemsSummary} will be delivered to ${orderDraft.deliveryAddress} under ${draft.customerName}. Total is ${total} AED. Is there anything else I can help you with?`
        : `Perfect! Your order for ${itemsSummary} is ready for pickup under ${draft.customerName}. Total is ${total} AED. Is there anything else I can help you with?`;

      return { response: confirmMsg };
    }

    // Fallback
    return { response: aiResponse || "How can I help you?" };
  }

  /**
   * ================================
   * GENERAL FALLBACK → AI with agent prompt
   * ================================
   */
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
