// src/controllers/llmSocketController.js

const Agent   = require("../models/Agent");
const Call    = require("../models/Call");
const Booking = require("../models/Booking");
const Order   = require("../models/Order");
const { getAIResponse }            = require("../services/aiChatService");
const { findNearestAvailableSlot } = require("../services/bookingService");

// ─── PER-CALL PROCESSING LOCK ─────────────────────────────────────────────────
const activeCallProcessing = new Map();
function acquireLock(callId) {
  const now = Date.now();
  const last = activeCallProcessing.get(callId);
  if (last && now - last < 300) return false;
  activeCallProcessing.set(callId, now);
  return true;
}
function releaseLock(callId) { activeCallProcessing.delete(callId); }
setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of activeCallProcessing.entries()) {
    if (now - ts > 10000) activeCallProcessing.delete(id);
  }
}, 30000);

// ─── LANGUAGE DETECTION ───────────────────────────────────────────────────────
// Detects if text contains Arabic characters
function containsArabic(text) {
  if (!text) return false;
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(text);
}

// Detects language from text — returns "ar" or "en"
function detectLanguage(text) {
  if (!text?.trim()) return null;
  if (containsArabic(text)) return "ar";
  // Arabic words written in English (transliterated)
  const arabicTransliterated = /\b(marhaba|ahlan|salam|habibi|yalla|shukran|min fadlak|mumkin|biddi|areed|tayeb|mabrook|inshallah|wallah)\b/i;
  if (arabicTransliterated.test(text)) return "ar";
  return "en";
}

// ─── BILINGUAL RESPONSES ──────────────────────────────────────────────────────
const R = {
  // Greetings / Generic
  howCanIHelp:        { en: "How can I help you today?",                                          ar: "كيف أقدر أساعدك اليوم؟" },
  somethingWrong:     { en: "Sorry, something went wrong.",                                       ar: "عذراً، حدث خطأ ما." },
  oneMovement:        { en: "One moment please...",                                               ar: "لحظة من فضلك..." },
  goodbye:            { en: "Thank you for calling! Have a wonderful day. Goodbye!",              ar: "شكراً لاتصالك! أتمنى لك يوماً رائعاً. مع السلامة!" },
  anythingElse:       { en: "Is there anything else I can help you with?",                       ar: "هل هناك أي شيء آخر أقدر أساعدك فيه؟" },
  sorryDidntCatch:    { en: "Sorry, I didn't catch that.",                                        ar: "عذراً، لم أفهم ذلك." },

  // Booking
  bookingConfirmed:   (name, size, time) => ({
    en: `Perfect! Your table for ${size} is confirmed at ${time} under ${name}. Is there anything else I can help you with?`,
    ar: `ممتاز! تم تأكيد طاولتك لـ${size} أشخاص الساعة ${time} باسم ${name}. هل هناك أي شيء آخر أقدر أساعدك فيه؟`,
  }),
  bookingUpdated:     (name, size, time) => ({
    en: `Done! Your booking has been updated to ${size} people at ${time} under ${name}. Is there anything else I can help you with?`,
    ar: `تم! تم تحديث حجزك إلى ${size} أشخاص الساعة ${time} باسم ${name}. هل هناك أي شيء آخر أقدر أساعدك فيه؟`,
  }),
  bookingCancelled:   { en: "Done! Your booking has been cancelled. Is there anything else I can help you with?",  ar: "تم! تم إلغاء حجزك. هل هناك أي شيء آخر أقدر أساعدك فيه؟" },
  noAvailability:     { en: "I'm sorry, we don't have availability at that time. Would you like a different time?", ar: "عذراً، لا يوجد لدينا طاولة متاحة في هذا الوقت. هل تريد وقتاً آخر؟" },
  suggestTime:        (time) => ({
    en: `We're fully booked at that time. Would ${time} work instead?`,
    ar: `للأسف محجوز في ذلك الوقت. هل يناسبك ${time}؟`,
  }),

  // Order
  orderConfirmedDelivery: (items, address, name, total) => ({
    en: `Perfect! Your order for ${items} will be delivered to ${address} under ${name}. Total is ${total} AED. Is there anything else I can help you with?`,
    ar: `ممتاز! طلبك لـ${items} سيتم توصيله إلى ${address} باسم ${name}. المجموع ${total} درهم. هل هناك أي شيء آخر أقدر أساعدك فيه؟`,
  }),
  orderConfirmedPickup: (items, name, time, total) => ({
    en: `Perfect! Your order for ${items} is ready for pickup under ${name}${time ? ` at ${time}` : ""}. Total is ${total} AED. Is there anything else I can help you with?`,
    ar: `ممتاز! طلبك لـ${items} جاهز للاستلام باسم ${name}${time ? ` الساعة ${time}` : ""}. المجموع ${total} درهم. هل هناك أي شيء آخر أقدر أساعدك فيه؟`,
  }),
  orderConfirmedDineIn: (size, time, name, items, total) => ({
    en: `Perfect! Your table for ${size} is booked at ${time} under ${name}, and your ${items} will be ready when you arrive. Total is ${total} AED. Is there anything else I can help you with?`,
    ar: `ممتاز! تم حجز طاولتك لـ${size} أشخاص الساعة ${time} باسم ${name}، و${items} ستكون جاهزة عند وصولك. المجموع ${total} درهم. هل هناك أي شيء آخر أقدر أساعدك فيه؟`,
  }),
  orderCancelled:     { en: "Done! Your order has been cancelled. Is there anything else I can help you with?",    ar: "تم! تم إلغاء طلبك. هل هناك أي شيء آخر أقدر أساعدك فيه؟" },
  orderTooOldCancel:  (mins) => ({
    en: `I'm sorry, your order was placed ${mins} minutes ago and cannot be cancelled.`,
    ar: `عذراً، طلبك تم منذ ${mins} دقيقة ولا يمكن إلغاؤه.`,
  }),
  orderTooOldModify:  (mins) => ({
    en: `I'm sorry, your order was placed ${mins} minutes ago and cannot be modified.`,
    ar: `عذراً، طلبك تم منذ ${mins} دقيقة ولا يمكن تعديله.`,
  }),

  // Questions — Booking
  askPartySize:       { en: "How many people will be joining?",       ar: "كم شخص سيحضر؟" },
  askTime:            { en: "What time would you like?",              ar: "في أي وقت تريد؟" },
  askName:            { en: "What name should I put the booking under?", ar: "باسم من الحجز؟" },
  askOrderName:       { en: "What name should I put the order under?",   ar: "باسم من الطلب؟" },

  // Questions — Order
  askDeliveryAddress: { en: "What is the delivery address?",          ar: "ما هو عنوان التوصيل؟" },
  askPickupTime:      { en: "What time would you like to pick up your order?", ar: "في أي وقت تريد استلام طلبك؟" },
  askDiningTime:      { en: "What time would you like to dine?",      ar: "في أي وقت تريد تناول الطعام؟" },
  askDiningPeople:    { en: "How many people will be dining?",        ar: "كم شخص سيتناول الطعام؟" },
  askNewAddress:      { en: "Sure! What is the new delivery address?", ar: "بالتأكيد! ما هو العنوان الجديد للتوصيل؟" },

  // Returning caller
  isThisYou:          (name) => ({
    en: `${name}? Is that right?`,
    ar: `${name}؟ هل هذا صحيح؟`,
  }),
  returningGreet:     (msg) => ({
    en: `Great! ${msg} How can I help you?`,
    ar: `ممتاز! ${msg} كيف أقدر أساعدك؟`,
  }),
  notYou:             { en: "I'm sorry about that! How can I help you today?", ar: "عذراً على ذلك! كيف أقدر أساعدك اليوم؟" },

  // Returning context messages
  returningBookingCtx: (size, time, name) => ({
    en: `I have your table booking for ${size} at ${time}.`,
    ar: `لدي حجزك لـ${size} أشخاص الساعة ${time}.`,
  }),
  returningOrderCtx:   (type, items, status) => ({
    en: `I have your ${type} order for ${items} — it's currently ${status}.`,
    ar: `لدي طلبك لـ${items} — الحالة الآن ${status}.`,
  }),

  // Name update
  nameUpdated:        (name) => ({
    en: `Done! I've updated the booking name to ${name}. Is there anything else I can help you with?`,
    ar: `تم! تم تغيير اسم الحجز إلى ${name}. هل هناك أي شيء آخر أقدر أساعدك فيه؟`,
  }),
  askNewName:         { en: "What name would you like the booking under?", ar: "باسم من تريد الحجز؟" },
};

// Helper: get response in correct language
function t(key, lang, ...args) {
  const val = typeof R[key] === "function" ? R[key](...args) : R[key];
  if (!val) return "";
  return val[lang] || val.en;
}

// ─── ORDER STATUS TRANSLATION ──────────────────────────────────────────────────
function translateStatus(status, lang) {
  const map = {
    confirmed: { en: "received and confirmed",    ar: "تم الاستلام والتأكيد" },
    preparing: { en: "currently being prepared",  ar: "قيد التحضير الآن" },
    ready:     { en: "ready for pickup",          ar: "جاهز للاستلام" },
    delivered: { en: "delivered",                 ar: "تم التوصيل" },
    cancelled: { en: "cancelled",                 ar: "ملغي" },
  };
  return map[status]?.[lang] || status;
}

function translateOrderType(type, lang) {
  const map = {
    delivery: { en: "delivery", ar: "توصيل" },
    pickup:   { en: "pickup",   ar: "استلام" },
    dineIn:   { en: "dine-in",  ar: "تناول داخل المطعم" },
  };
  return map[type]?.[lang] || type;
}

// ─── ARABIC NAME TRANSLITERATION ──────────────────────────────────────────────
// Converts Arabic name to English equivalent for MongoDB storage
async function transliterateToEnglish(arabicText) {
  if (!arabicText || !containsArabic(arabicText)) return arabicText;
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 50,
        temperature: 0,
        messages: [{
          role: "user",
          content: `Transliterate this Arabic name to English letters only. Return ONLY the transliterated name, nothing else: "${arabicText}"`,
        }],
      }),
    });
    const data = await response.json();
    const result = data.choices?.[0]?.message?.content?.trim();
    return result || arabicText;
  } catch {
    return arabicText;
  }
}

// ─── FORMAT HELPERS ───────────────────────────────────────────────────────────
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
      let line = `  - ${i.name}: ${i.price} ${i.currency || "AED"}`;
      if (i.description) line += ` — ${i.description}`;
      if (i.extras?.length) line += ` (Extras: ${i.extras.map(e => `${e.name} +${e.price}`).join(", ")})`;
      return line;
    });
    return `${cat}:\n${lines.join("\n")}`;
  }).join("\n\n");
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

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
function buildSystemPrompt(agent, lang) {
  const hasBookings = agent.features?.bookings !== false;
  const hasOrders   = agent.features?.orders === true;
  const hasDelivery = agent.features?.delivery === true;
  const hasPickup   = agent.features?.pickup === true;
  const hasDineIn   = agent.features?.dineIn !== false;

  const features = [];
  if (hasBookings) features.push(lang === "ar" ? "حجز الطاولات" : "table reservations");
  if (hasOrders && hasDineIn) features.push(lang === "ar" ? "طلبات الأكل داخل المطعم" : "dine-in orders");
  if (hasOrders && hasPickup) features.push(lang === "ar" ? "طلبات الاستلام" : "pickup orders");
  if (hasOrders && hasDelivery) features.push(lang === "ar" ? "طلبات التوصيل" : "delivery orders");

  const basePrompt = agent.agentPrompt?.trim()
    ? agent.agentPrompt
    : lang === "ar"
      ? `أنت ${agent.agentName || "مساعد ذكي"} في ${agent.businessName}. أنت ودود ومحترف ومفيد.`
      : `You are ${agent.agentName || "an AI receptionist"} at ${agent.businessName}. You are friendly, professional, and helpful.`;

  if (lang === "ar") {
    return `${basePrompt}

تقدر تساعد العملاء في: ${features.join("، ") || "الاستفسارات العامة"}.

قواعد اللغة:
- تكلم دائماً بالعربية في هذه المحادثة
- استخدم لغة عربية طبيعية وواضحة مناسبة للمكالمات الهاتفية
- لا تخلط بين العربية والإنجليزية في نفس الجملة

أوقات العمل:
${formatOpeningHours(agent.openingHours)}

${hasOrders && agent.menu?.length > 0 ? `القائمة:\n${formatMenu(agent.menu)}` : ""}

القواعد:
- اسأل سؤالاً واحداً فقط في كل رد
- اجعل ردودك قصيرة وطبيعية مناسبة للمكالمة
- لا تطلب رقم الهاتف من العميل
- لا تذكر التواريخ للحجوزات، فقط الأوقات
- لا تقترح الطلب بعد تأكيد الحجز
- بدلاً من "party size" قل "كم شخص"
- إذا طلب العميل شيئاً غير موجود في القائمة، اعتذر بلطف وقل إنه غير متوفر
- كن دافئاً ومرحباً دائماً`;
  }

  return `${basePrompt}

You can help customers with: ${features.join(", ") || "general inquiries"}.

LANGUAGE: Respond in English throughout this conversation.

Opening Hours:
${formatOpeningHours(agent.openingHours)}

${hasOrders && agent.menu?.length > 0 ? `Menu:\n${formatMenu(agent.menu)}` : ""}

Rules:
- Ask ONE question at a time
- Keep responses short and natural for a phone call
- Never ask for the customer's phone number
- Never mention dates for reservations, only times
- NEVER suggest ordering after a booking is confirmed
- NEVER say "party size" — say "how many people" instead
- If asked about something not on the menu, politely say it is not available
- Always be warm and welcoming`;
}

// ─── EXTRACTION ───────────────────────────────────────────────────────────────
async function extractAndRespond(text, currentDraft, orderDraft, transcript, agent, returningContext, lang) {
  if (!text?.trim()) return { extracted: {}, orderExtracted: {}, response: null, intent: null };

  const hasOrders = agent.features?.orders === true;
  const recentConvo = (transcript ?? []).slice(-4)
    .map(t => `${t.role === "agent" ? "Agent" : "Customer"}: ${t.content}`)
    .join("\n");

  const menuText = hasOrders && agent.menu?.length > 0
    ? `Available menu:\n${formatMenu(agent.menu)}` : "";

  const returningInfo = returningContext ? `Returning customer context: ${returningContext}` : "";

  const now = new Date();
  const currentTimeStr = now.toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Dubai",
  });

  const langNote = lang === "ar"
    ? `The customer is speaking Arabic. You MUST:
- Understand Arabic numbers: واحد=1, اثنين=2, ثلاثة=3, أربعة=4, خمسة=5, ستة=6, سبعة=7, ثمانية=8, تسعة=9, عشرة=10
- Understand Arabic time: "الساعة سبعة" = 7:00, "الساعة سبعة ونص" = 7:30, "بعد ساعة" = in 1 hour from now, "بعد نص ساعة" = in 30 minutes
- Understand Arabic order types: "توصيل" or "يوصلوا" = delivery, "استلام" or "آخذه" or "أجي آخذه" = pickup, "أكل داخل" or "نجلس" or "نأكل هناك" = dineIn
- Extract Arabic names as-is in the name field (they will be transliterated separately)
- Understand Arabic addresses and locations
- Understand corrections in Arabic: "لا قصدي" or "مو كذا" = correction, "إلغي" or "ألغي" = cancel, "غير" or "بدّل" = modify
- Your response MUST be in Arabic, warm and natural for a phone call
- Even if you respond in Arabic, the JSON keys stay in English`
    : `The customer is speaking English. Respond in English.`;

  const prompt = `You are a receptionist at ${agent.businessName}.
Current time in Dubai: ${currentTimeStr}
${langNote}

Current state:
- Booking: people=${currentDraft.partySize ?? "not collected"}, time=${currentDraft.requestedStart ? new Date(currentDraft.requestedStart).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:true,timeZone:"Asia/Dubai"}) : "not collected"}, name=${currentDraft.customerName ?? "not collected"}
- Order: items=${orderDraft.items?.length > 0 ? orderDraft.items.map(i=>`${i.name}x${i.quantity}`).join(",") : "none"}, type=${orderDraft.orderType ?? "not set"}, address=${orderDraft.deliveryAddress ?? "not collected"}
${returningInfo}

${menuText}

Recent conversation:
${recentConvo}

Customer just said: "${text}"

STRICT RULES:
- Current time is ${currentTimeStr}. When customer says relative time ("in X minutes", "بعد ساعة", "after X hours"), calculate actual time from current Dubai time and return HH:MM 24hr.
- If customer says "book a table" or "احجز طاولة" with NO food items, this is BOOKING ONLY. Do NOT ask about order type.
- ALWAYS extract orderType from ANY language form:
  * Arabic delivery: "توصيل", "يوصلوا", "ابعتوه", "وصلوه" = "delivery"
  * Arabic pickup: "استلام", "آخذه", "أجي آخذه", "تيك اواي" = "pickup"  
  * Arabic dineIn: "نجلس", "نأكل هناك", "أكل داخل", "دايني" = "dineIn"
  * English delivery: "delivery", "deliver it", "bring it to me" = "delivery"
  * English pickup: "pickup", "pick up", "collect", "take away" = "pickup"
  * English dineIn: "dine in", "eat here", "eat at the restaurant" = "dineIn"
- For names: extract the name exactly as spoken (Arabic or English). Store as-is.
- For Arabic numbers in party size: convert to integer (ثلاثة = 3, أربعة = 4, etc.)
- For addresses: extract meaningful location, remove filler words in any language
- Never ask for phone number
- Never mention dates, only times
- If all required info collected, return null for response
- intent: "cancel" if customer wants to cancel, "modify" if wants to change, "new" otherwise

Respond ONLY with valid JSON (no markdown):
{
  "extracted": {"partySize": <number or null>, "time": "<HH:MM 24hr or null>", "name": "<string or null>"},
  "orderExtracted": {"items": [{"name": "<exact English menu item name>", "quantity": <number>, "extras": []}], "orderType": "<dineIn|pickup|delivery|null>", "deliveryAddress": "<cleaned address or null>"},
  "intent": "<cancel|modify|new|null>",
  "response": "<your reply in ${lang === "ar" ? "Arabic" : "English"} or null>"
}`;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 500,
        temperature: 0.2,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await response.json();
    const raw   = data.choices?.[0]?.message?.content?.trim() ?? "{}";
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    console.log("🎯 Extraction:", parsed);
    return {
      extracted:      parsed.extracted      ?? {},
      orderExtracted: parsed.orderExtracted ?? {},
      intent:         parsed.intent         ?? null,
      response:       parsed.response       ?? null,
    };
  } catch (err) {
    console.error("❌ OpenAI extraction error:", err.message);
    return { extracted: {}, orderExtracted: {}, response: null, intent: null };
  }
}

// ─── INTENT DETECTION ─────────────────────────────────────────────────────────
function looksLikeBookingIntent(text) {
  if (!text) return false;
  return /\b(book|reserve|reservation|table)\b/i.test(text) ||
    /احجز|حجز|طاولة|أريد طاولة|ابي طاولة/.test(text);
}
function looksLikeOrderIntent(text) {
  if (!text) return false;
  return /\b(order|food|eat|hungry|menu|delivery|pickup|take.?away|bring|want to eat)\b/i.test(text) ||
    /اطلب|طلب|أكل|جوعان|قائمة|توصيل|استلام|ابي آكل|أريد أن آكل/.test(text);
}
function looksLikeCancelIntent(text) {
  if (!text) return false;
  return /\b(cancel|cancellation|delete|remove|forget|drop|never mind|nevermind)\b/i.test(text) ||
    /إلغ|ألغي|امسح|لا أريد|ما أبي|بطّل/.test(text);
}
function looksLikeModifyIntent(text) {
  if (!text) return false;
  return /\b(change|modify|update|edit|make it|instead|switch|different|wrong|correct|fix|actually)\b/i.test(text) ||
    /غيّر|بدّل|عدّل|مو كذا|قصدي|لا لا|أقصد|اصلاً/.test(text);
}
function looksLikeGoodbye(text) {
  if (!text) return false;
  return /\b(bye|goodbye|bye bye|thank you|thanks|that's all|nothing else|no thank)\b/i.test(text) ||
    /مع السلامة|شكراً|وداعاً|بس كذا|ما في غير|لا شكراً|يسلموا/.test(text);
}

// ─── BOOKING ENGINE LOCK ──────────────────────────────────────────────────────
const processingCalls = new Set();

// ─── MAIN ENTRY ──────────────────────────────────────────────────────────────
async function processLLMMessage(body, req) {
  console.log("🎯 WEBSOCKET LLM CONTROLLER HIT");

  const interactionType = body.interaction_type || body.type;
  if (interactionType === "ping_pong") return null;
  if (interactionType !== "response_required") return null;

  let callId = body.call_id || body.callId || body?.metadata?.call_id || null;
  if (!callId && req?.url) {
    const parts = req.url.split("/");
    const last  = parts[parts.length - 1];
    if (last?.startsWith("call_")) callId = last;
  }
  if (!callId) return { response: "Sorry, something went wrong." };

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

  // ── LOAD CALL ─────────────────────────────────────────────
  const freshCall = await Call.findOne({ $or: [{ callId }, { call_id: callId }] }).lean();
  if (!freshCall) return { response: "Sorry, something went wrong." };

  // ── LOAD AGENT ────────────────────────────────────────────
  const agent = await Agent.findById(freshCall.agentId).lean();
  if (!agent) return { response: "Sorry, something went wrong." };

  // ── PHONE ─────────────────────────────────────────────────
  const phoneFromBody =
    body?.call?.from_number || body?.call?.caller_id ||
    body?.call?.from || body?.call?.customer_number || body?.from_number || null;
  const callerPhone = freshCall.callerNumber || phoneFromBody || null;
  if (!freshCall.callerNumber && phoneFromBody) {
    await Call.updateOne({ _id: freshCall._id }, { $set: { callerNumber: phoneFromBody } });
  }

  // ── USER TEXT ─────────────────────────────────────────────
  const latestUserText = typeof body.latest_user_text === "string"
    ? body.latest_user_text.trim() : "";
  const transcript = body.transcript ?? [];
  console.log(`🗣 User: ${latestUserText}`);

  // ── LANGUAGE DETECTION & PERSISTENCE ─────────────────────
  // IMPORTANT: Always detect from current message first.
  // Only use stored lang as fallback if current message is too short/noisy
  // to detect from. Never inherit lang blindly from a previous call's meta.
  const detectedNow = detectLanguage(latestUserText);
  let lang = detectedNow; // prefer current message detection

  if (!lang) {
    // Current message undetectable — check if we already detected in THIS call
    // (stored mid-call, not inherited from a previous call)
    const storedLang = freshCall.meta?.lang;
    const callAge = Date.now() - new Date(freshCall.createdAt).getTime();
    // Only trust stored lang if call is recent (same call session)
    if (storedLang && callAge < 30 * 60 * 1000) {
      lang = storedLang;
    }
  }

  if (!lang) lang = "en"; // default to English

  // Persist if changed
  if (lang !== freshCall.meta?.lang) {
    await Call.updateOne({ _id: freshCall._id }, { $set: { "meta.lang": lang } });
  }
  console.log(`🌐 Language: ${lang}`);

  // ── DRAFT STATE ───────────────────────────────────────────
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

  // ── BOOKING INTENT RESET ──────────────────────────────────
  if (looksLikeBookingIntent(latestUserText) && !looksLikeOrderIntent(latestUserText)) {
    orderDraft.orderType = null;
    orderDraft.status    = null;
    if (orderDraft.items?.length > 0 && orderDraft.status !== "confirmed") orderDraft.items = [];
    if (orderDraft.items?.length === 0) {
      draft.requestedStart = null;
      draft.partySize      = null;
    }
    await Call.updateOne({ _id: freshCall._id }, {
      $set: {
        "orderDraft.orderType":        null,
        "orderDraft.status":           null,
        ...(orderDraft.items?.length === 0 ? {
          "bookingDraft.requestedStart": null,
          "bookingDraft.partySize":      null,
        } : {}),
      }
    });
  }

  // ── RETURNING CALLER ──────────────────────────────────────
  let returningContext             = null;
  let awaitingReturnConfirmation   = freshCall.meta?.awaitingReturnConfirmation ?? false;
  let returnConfirmed              = freshCall.meta?.returnConfirmed ?? false;

  const mentionsChange = /\b(cancel|change|modify|update|edit|fix|correct|i called|i ordered|earlier|last time|my order|my booking|placed|made a booking|status|where is my|check my|track my|order status|what happened|how long|when will)\b/i.test(latestUserText) ||
    /إلغ|غيّر|عدّل|طلبي|حجزي|اتصلت|طلبت|قبل شوي|وين طلبي|متى|كم وقت/.test(latestUserText);

  const hasActiveDraft = orderDraft.items?.length > 0 || orderDraft.orderType || draft.partySize || draft.requestedStart;
  const justConfirmedBooking = await Booking.findOne({ callId, status: { $in: ["confirmed","seated"] } }).lean();
  const hasActiveDraftOrConfirmed = hasActiveDraft || !!justConfirmedBooking;

  if (callerPhone && mentionsChange && !awaitingReturnConfirmation && !returnConfirmed && !hasActiveDraftOrConfirmed) {
    const previousCall = await Call.findOne({
      _id: { $ne: freshCall._id },
      $or: [{ callerNumber: callerPhone }, { "bookingDraft.customerPhone": callerPhone }],
      agentId: freshCall.agentId,
    }).sort({ createdAt: -1 }).lean();

    if (previousCall) {
      const prevBooking = await Booking.findOne({ callId: previousCall.callId, status: { $in: ["confirmed","seated"] } }).lean();
      const prevOrder   = await Order.findOne({ callId: previousCall.callId, status: { $in: ["confirmed","preparing","ready"] } }).lean();

      if (prevBooking || prevOrder) {
        const name = prevBooking?.customerName || prevOrder?.customerName;
        if (name) {
          await Call.updateOne({ _id: freshCall._id }, {
            $set: {
              "meta.awaitingReturnConfirmation": true,
              "meta.returningName":              name,
              "meta.returningBookingId":         prevBooking?._id?.toString() ?? null,
              "meta.returningOrderId":           prevOrder?._id?.toString()   ?? null,
            }
          });
          console.log(`📞 Returning caller detected: ${name}`);
          return { response: t("isThisYou", lang, name) };
        }
      }
    }
  }

  // ── RETURNING CALLER CONFIRMATION ─────────────────────────
  if (awaitingReturnConfirmation && !returnConfirmed) {
    const isYes = /\b(yes|yeah|yep|correct|that's me|right|yup|sure|exactly|affirmative)\b/i.test(latestUserText) ||
      /نعم|آه|أيوه|صح|صحيح|تمام|أكيد/.test(latestUserText);
    const isNo  = /\b(no|nope|wrong|not me|different|incorrect)\b/i.test(latestUserText) ||
      /لا|مو أنا|غلط|مو صح/.test(latestUserText);

    if (isYes) {
      const returningName      = freshCall.meta?.returningName;
      const returningBookingId = freshCall.meta?.returningBookingId;
      const returningOrderId   = freshCall.meta?.returningOrderId;
      draft.customerName       = returningName;
      await Call.updateOne({ _id: freshCall._id }, {
        $set: {
          "meta.returnConfirmed":            true,
          "meta.awaitingReturnConfirmation": false,
          "bookingDraft.customerName":       returningName,
        }
      });

      let contextMsg = "";
      if (returningBookingId) {
        const rb = await Booking.findById(returningBookingId).lean();
        if (rb) {
          const timeStr = new Date(rb.startTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Dubai" });
          contextMsg = lang === "ar"
            ? `لدي حجزك لـ${rb.partySize} أشخاص الساعة ${timeStr}.`
            : `I have your table booking for ${rb.partySize} at ${timeStr}.`;
        }
      }
      if (!contextMsg && returningOrderId) {
        const ro = await Order.findById(returningOrderId).lean();
        if (ro) {
          const itemsSummary = ro.items.map(i => `${i.name} x${i.quantity}`).join(", ");
          const statusMsg    = translateStatus(ro.status, lang);
          contextMsg = lang === "ar"
            ? `لدي طلبك لـ${itemsSummary} — الحالة الآن ${statusMsg}.`
            : `I have your ${ro.orderType} order for ${itemsSummary} — it's currently ${statusMsg}.`;
        }
      }
      return { response: t("returningGreet", lang, contextMsg) };
    }

    if (isNo) {
      await Call.updateOne({ _id: freshCall._id }, {
        $set: {
          "meta.awaitingReturnConfirmation": false,
          "meta.returnConfirmed":            false,
        }
      });
      return { response: t("notYou", lang) };
    }

    return { response: lang === "ar"
      ? `عذراً، لم أفهم. هل أنت ${freshCall.meta?.returningName}؟`
      : `Sorry, I didn't catch that. Is this ${freshCall.meta?.returningName}?`
    };
  }

  // ── CONFIRMED IDs ─────────────────────────────────────────
  const confirmedBookingId = freshCall.meta?.returningBookingId ?? null;
  const confirmedOrderId   = freshCall.meta?.returningOrderId   ?? null;
  returnConfirmed          = freshCall.meta?.returnConfirmed     ?? false;

  // ── INTENT DETECTION ──────────────────────────────────────
  const recentTranscriptText = transcript.slice(-4).map(t => t.content).join(" ");
  const cancelIntent = looksLikeCancelIntent(latestUserText);
  const modifyIntent = looksLikeModifyIntent(latestUserText);

  const bookingFlowActive =
    !!draft.partySize || !!draft.requestedStart ||
    (!returnConfirmed && !!draft.customerName) ||
    looksLikeBookingIntent(latestUserText) ||
    looksLikeBookingIntent(recentTranscriptText);

  const orderFlowActive =
    agent.features?.orders === true && (
      !!orderDraft.items?.length || !!orderDraft.orderType ||
      looksLikeOrderIntent(latestUserText) ||
      looksLikeOrderIntent(recentTranscriptText)
    );

  // ── CANCEL — RETURNING CALLER ─────────────────────────────
  if (cancelIntent && returnConfirmed) {
    const wantsToCancel = latestUserText.toLowerCase();
    if (confirmedBookingId && (wantsToCancel.includes("book") || wantsToCancel.includes("reserv") || wantsToCancel.includes("table") || /حجز|طاولة/.test(wantsToCancel) || !wantsToCancel.includes("order"))) {
      const booking = await Booking.findById(confirmedBookingId);
      if (booking) {
        await Booking.updateOne({ _id: confirmedBookingId }, { $set: { status: "cancelled" } });
        await Call.updateOne({ _id: freshCall._id }, {
          $set: {
            "meta.returningBookingId":         null,
            "bookingDraft.partySize":          null,
            "bookingDraft.requestedStart":     null,
            "bookingDraft.customerName":       null,
          }
        });
        return { response: t("bookingCancelled", lang) };
      }
    }
    if (confirmedOrderId) {
      const order = await Order.findById(confirmedOrderId);
      if (order) {
        const mins = (Date.now() - new Date(order.createdAt).getTime()) / 60000;
        if (mins > 5) return { response: t("orderTooOldCancel", lang, Math.floor(mins)) };
        await Order.updateOne({ _id: confirmedOrderId }, { $set: { status: "cancelled" } });
        await Call.updateOne({ _id: freshCall._id }, {
          $set: {
            "meta.returningOrderId":    null,
            "orderDraft.items":         [],
            "orderDraft.orderType":     null,
            "orderDraft.status":        null,
            "orderDraft.deliveryAddress": null,
          }
        });
        return { response: t("orderCancelled", lang) };
      }
    }
  }

  // ── CANCEL — SAME CALL ────────────────────────────────────
  if (cancelIntent && orderDraft.status === "confirmed") {
    const existingOrder = await Order.findOne({ callId, status: { $in: ["confirmed","preparing"] } }).sort({ createdAt: -1 });
    if (existingOrder) {
      const mins = (Date.now() - new Date(existingOrder.createdAt).getTime()) / 60000;
      if (mins > 5) return { response: t("orderTooOldCancel", lang, Math.floor(mins)) };
      await Order.updateOne({ _id: existingOrder._id }, { $set: { status: "cancelled" } });
      await Call.updateOne({ _id: freshCall._id }, {
        $set: {
          "orderDraft.items":         [],
          "orderDraft.orderType":     null,
          "orderDraft.status":        "cancelled",
          "orderDraft.deliveryAddress": null,
        }
      });
      return { response: t("orderCancelled", lang) };
    }
  }

  if (cancelIntent && (bookingFlowActive || looksLikeBookingIntent(latestUserText))) {
    const existingBooking = await Booking.findOne({ callId, status: { $in: ["confirmed","seated"] } });
    if (existingBooking) {
      await Booking.updateOne({ _id: existingBooking._id }, { $set: { status: "cancelled" } });
      await Call.updateOne({ _id: freshCall._id }, {
        $set: {
          "bookingDraft.partySize":      null,
          "bookingDraft.requestedStart": null,
          "bookingDraft.customerName":   null,
        }
      });
      return { response: t("bookingCancelled", lang) };
    }
  }

  // ── MODIFY NAME ───────────────────────────────────────────
  if (modifyIntent && returnConfirmed && confirmedBookingId) {
    const wantsToChangeName = /\b(name|under|rename|change.*name)\b/i.test(latestUserText) ||
      /اسم|غيّر الاسم|بدّل الاسم/.test(latestUserText);
    if (wantsToChangeName) {
      const { extracted: nameExtracted } = await extractAndRespond(latestUserText, draft, orderDraft, transcript, agent, null, lang);
      if (nameExtracted.name) {
        // Transliterate if Arabic
        const storedName = containsArabic(nameExtracted.name)
          ? await transliterateToEnglish(nameExtracted.name)
          : nameExtracted.name;
        await Booking.updateOne({ _id: confirmedBookingId }, { $set: { customerName: storedName } });
        // Respond with original spoken name
        const displayName = lang === "ar" ? nameExtracted.name : storedName;
        return { response: t("nameUpdated", lang, displayName) };
      }
      return { response: t("askNewName", lang) };
    }
  }

  // ── MODIFY — RETURNING ORDER ──────────────────────────────
  if (modifyIntent && returnConfirmed && confirmedOrderId) {
    const existingOrder = await Order.findById(confirmedOrderId);
    if (existingOrder) {
      const mins = (Date.now() - new Date(existingOrder.createdAt).getTime()) / 60000;
      if (mins > 5) return { response: t("orderTooOldModify", lang, Math.floor(mins)) };
      orderDraft.items           = existingOrder.items;
      orderDraft.orderType       = existingOrder.orderType;
      orderDraft.deliveryAddress = existingOrder.deliveryAddress;
      orderDraft.status          = null;
      await Call.updateOne({ _id: freshCall._id }, {
        $set: {
          "orderDraft.items":           existingOrder.items,
          "orderDraft.orderType":       existingOrder.orderType,
          "orderDraft.deliveryAddress": existingOrder.deliveryAddress,
          "orderDraft.status":          null,
        }
      });
    }
  }

  // ── ORDER CONFIRMED — handle next action ──────────────────
  if (orderDraft.status === "confirmed") {
    if (looksLikeGoodbye(latestUserText)) {
      return { response: t("goodbye", lang), end_call: true };
    }
    if (looksLikeOrderIntent(latestUserText) && !modifyIntent && !cancelIntent) {
      orderDraft = { items: [], orderType: null, status: null, deliveryAddress: null };
      await Call.updateOne({ _id: freshCall._id }, {
        $set: {
          "orderDraft.items":           [],
          "orderDraft.orderType":       null,
          "orderDraft.status":          null,
          "orderDraft.deliveryAddress": null,
        }
      });
    } else if (looksLikeBookingIntent(latestUserText)) {
      draft.customerName = null;
      await Call.updateOne({ _id: freshCall._id }, { $set: { "bookingDraft.customerName": null } });
    } else if (modifyIntent || cancelIntent) {
      const existingOrder = await Order.findOne({ callId, status: { $in: ["confirmed","preparing"] } }).sort({ createdAt: -1 });
      if (existingOrder) {
        const mins = (Date.now() - new Date(existingOrder.createdAt).getTime()) / 60000;
        if (mins > 5) return { response: t("orderTooOldModify", lang, Math.floor(mins)) };
        const mentionsAddress = /\b(address|location|deliver|where)\b/i.test(latestUserText) ||
          /عنوان|موقع|توصيل|وين/.test(latestUserText);
        orderDraft.items           = existingOrder.items;
        orderDraft.orderType       = existingOrder.orderType;
        orderDraft.deliveryAddress = mentionsAddress ? null : existingOrder.deliveryAddress;
        orderDraft.status          = null;
        await Call.updateOne({ _id: freshCall._id }, {
          $set: {
            "orderDraft.items":           existingOrder.items,
            "orderDraft.orderType":       existingOrder.orderType,
            "orderDraft.deliveryAddress": mentionsAddress ? null : existingOrder.deliveryAddress,
            "orderDraft.status":          null,
          }
        });
        if (mentionsAddress) return { response: t("askNewAddress", lang) };
      }
    } else {
      return { response: t("anythingElse", lang) };
    }
  }

  // ── ACTIVE FLOW ───────────────────────────────────────────
  if (bookingFlowActive || orderFlowActive || cancelIntent || modifyIntent) {

    if (looksLikeGoodbye(latestUserText)) {
      return { response: t("goodbye", lang), end_call: true };
    }

    const returningCtxString = returningContext ||
      (confirmedBookingId ? "Has existing booking" : null) ||
      (confirmedOrderId   ? "Has existing order"   : null);

    const { extracted, orderExtracted, intent, response: aiResponse } =
      await extractAndRespond(latestUserText, draft, orderDraft, transcript, agent, returningCtxString, lang);

    console.log("🧠 Extracted:", extracted);
    console.log("🛒 Order extracted:", orderExtracted);
    console.log("🎯 Intent:", intent);

    // Force extract orderType from keywords if AI missed it
    if (!orderExtracted.orderType) {
      if (/\b(dine.?in|eat here|eat at|dining|come in|walk.?in|at the restaurant)\b/i.test(latestUserText) ||
          /نجلس|نأكل هناك|أكل داخل|دايني|بجلس/.test(latestUserText)) {
        orderExtracted.orderType = "dineIn";
      } else if (/\b(pick.?up|collect|take.?away|i'll come|come get)\b/i.test(latestUserText) ||
          /استلام|آخذه|أجي آخذه|تيك اواي/.test(latestUserText)) {
        orderExtracted.orderType = "pickup";
      } else if (/\b(deliver|delivery)\b/i.test(latestUserText) ||
          /توصيل|يوصلوا|ابعتوه/.test(latestUserText)) {
        orderExtracted.orderType = "delivery";
      }
    }

    // Update booking draft
    if (extracted.partySize && !draft.partySize) draft.partySize = extracted.partySize;
    if (extracted.time && !draft.requestedStart) {
      try {
        const [h, m] = extracted.time.split(":").map(Number);
        const dubaiOffset = 4 * 60;
        const now2 = new Date();
        const utcMs = now2.getTime() + (now2.getTimezoneOffset() * 60000);
        const dubaiNow = new Date(utcMs + (dubaiOffset * 60000));
        dubaiNow.setHours(h, m || 0, 0, 0);
        draft.requestedStart = new Date(dubaiNow.getTime() - (dubaiOffset * 60000));
      } catch (e) { console.error("❌ Time parse:", e); }
    }

    // Handle name — transliterate Arabic names to English for storage
    if (extracted.name) {
      const rawName = extracted.name;
      const storedName = containsArabic(rawName)
        ? await transliterateToEnglish(rawName)
        : rawName;
      draft.customerName = storedName;
      draft._displayName = rawName; // keep original for response
    }

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
        if (existingIndex >= 0) orderDraft.items[existingIndex].quantity = newItem.quantity || 1;
        else orderDraft.items.push(newItem);
      }
    }

    // Order type switch
    if (orderExtracted.orderType) {
      const newType  = orderExtracted.orderType;
      const prevType = orderDraft.orderType;
      if (newType !== prevType) {
        orderDraft.orderType       = newType;
        orderDraft.deliveryAddress = null;
        draft.partySize            = null;
        draft.requestedStart       = null;
        await Call.updateOne({ _id: freshCall._id }, {
          $set: {
            "orderDraft.orderType":        newType,
            "orderDraft.deliveryAddress":  null,
            "bookingDraft.partySize":      null,
            "bookingDraft.requestedStart": null,
          }
        });
      } else {
        orderDraft.orderType = newType;
      }
    }
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
      }
    });

    // Display name for responses (original Arabic or English)
    const displayName = draft._displayName || draft.customerName;

    // ── COMPLETION CHECKS ──────────────────────────────────
    // Bug fix: if no items in cart, this is a pure booking regardless of what
    // GPT extracted for orderType. GPT sometimes sets orderType="dineIn" on
    // table reservation requests — we ignore it when there are no items.
    const isPureBooking = orderDraft.items?.length === 0;
    if (isPureBooking && orderDraft.orderType) {
      // Clear the wrongly extracted orderType
      orderDraft.orderType = null;
      await Call.updateOne({ _id: freshCall._id }, {
        $set: { "orderDraft.orderType": null }
      });
    }

    const bookingComplete =
      bookingFlowActive && isPureBooking &&
      draft.partySize && draft.requestedStart && draft.customerName;

    const dineInComplete =
      orderDraft.orderType === "dineIn" &&
      orderDraft.items?.length > 0 && draft.partySize &&
      draft.requestedStart && draft.customerName;

    const pickupComplete =
      orderDraft.orderType === "pickup" &&
      orderDraft.items?.length > 0 && draft.requestedStart && draft.customerName;

    const deliveryComplete =
      orderDraft.orderType === "delivery" &&
      orderDraft.items?.length > 0 && orderDraft.deliveryAddress && draft.customerName;

    if (aiResponse && !bookingComplete && !dineInComplete && !pickupComplete && !deliveryComplete) {
      return { response: aiResponse };
    }
    if (dineInComplete && !orderDraft.orderType) orderDraft.orderType = "dineIn";

    // ── DINE-IN ────────────────────────────────────────────
    if (dineInComplete) {
      if (processingCalls.has(callId)) return { response: t("oneMovement", lang) };
      processingCalls.add(callId);
      try {
        const total = orderDraft.items.reduce((sum, item) => {
          const mi = agent.menu?.find(m => m.name.toLowerCase() === item.name.toLowerCase());
          return sum + (mi?.price || 0) * (item.quantity || 1);
        }, 0);
        const orderItems = orderDraft.items.map(item => {
          const mi = agent.menu?.find(m => m.name.toLowerCase() === item.name.toLowerCase());
          return { name: item.name, quantity: item.quantity || 1, price: mi?.price || 0, extras: item.extras || [] };
        });

        const existingBooking = await Booking.findOne({ callId, status: { $in: ["confirmed","seated"] } });
        const result = existingBooking
          ? { success: true }
          : await findNearestAvailableSlot({
              businessId: agent.businessId,
              requestedStart: draft.requestedStart,
              durationMinutes: 90,
              partySize: draft.partySize,
              source: "ai", agentId: agent._id, callId,
              customerName: draft.customerName,
              customerPhone: draft.customerPhone,
            });

        if (existingBooking) {
          await Booking.updateOne({ _id: existingBooking._id }, { $set: { partySize: draft.partySize, startTime: draft.requestedStart } });
        }

        if (result?.success) {
          await Order.create({
            callId, businessId: agent.businessId, agentId: agent._id,
            customerName: draft.customerName,
            customerPhone: draft.customerPhone || callerPhone,
            items: orderItems, orderType: "dineIn", total, status: "confirmed",
          });
          await Call.updateOne({ _id: freshCall._id }, {
            $set: {
              "bookingDraft.partySize": null, "bookingDraft.requestedStart": null, "bookingDraft.customerName": null,
              "orderDraft.items": [], "orderDraft.orderType": null, "orderDraft.deliveryAddress": null, "orderDraft.status": "confirmed",
            }
          });
          const timeString   = new Date(draft.requestedStart).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Dubai" });
          const itemsSummary = orderDraft.items.map(i => `${i.name} x${i.quantity || 1}`).join(", ");
          console.log("✅ Dine-in confirmed");
          return { response: t("orderConfirmedDineIn", lang, draft.partySize, timeString, displayName, itemsSummary, total) };
        }
        if (result?.suggestedTime) {
          const s = new Date(result.suggestedTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Dubai" });
          return { response: t("suggestTime", lang, s) };
        }
        return { response: t("noAvailability", lang) };
      } catch (err) {
        console.error("❌ Dine-in error:", err.message);
        return { response: t("somethingWrong", lang) };
      } finally {
        processingCalls.delete(callId);
      }
    }

    // ── BOOKING ONLY ───────────────────────────────────────
    if (bookingComplete) {
      if (processingCalls.has(callId)) return { response: t("oneMovement", lang) };
      processingCalls.add(callId);
      try {
        const existingBooking = await Booking.findOne({
          $or: [
            { callId, status: { $in: ["confirmed","seated"] } },
            ...(confirmedBookingId ? [{ _id: confirmedBookingId }] : []),
          ]
        });

        if (existingBooking) {
          await Booking.updateOne({ _id: existingBooking._id }, {
            $set: { partySize: draft.partySize, startTime: draft.requestedStart, customerName: draft.customerName }
          });
          await Call.updateOne({ _id: freshCall._id }, {
            $set: { "bookingDraft.partySize": null, "bookingDraft.requestedStart": null, "bookingDraft.customerName": null }
          });
          const timeString = new Date(draft.requestedStart).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Dubai" });
          console.log("✅ Booking updated");
          return { response: t("bookingUpdated", lang, displayName, draft.partySize, timeString) };
        }

        const result = await findNearestAvailableSlot({
          businessId: agent.businessId,
          requestedStart: draft.requestedStart,
          durationMinutes: 90,
          partySize: draft.partySize,
          source: "ai", agentId: agent._id, callId,
          customerName: draft.customerName,
          customerPhone: draft.customerPhone,
        });

        if (result?.success && result.booking) {
          await Call.updateOne({ _id: freshCall._id }, {
            $set: { "bookingDraft.partySize": null, "bookingDraft.requestedStart": null, "bookingDraft.customerName": null }
          });
          const timeString = new Date(result.booking.startIso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Dubai" });
          console.log("✅ Booking confirmed");
          return { response: t("bookingConfirmed", lang, displayName, draft.partySize, timeString) };
        }
        if (result?.suggestedTime) {
          const s = new Date(result.suggestedTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Dubai" });
          return { response: t("suggestTime", lang, s) };
        }
        return { response: t("noAvailability", lang) };
      } catch (err) {
        console.error("❌ Booking error:", err.message);
        return { response: t("somethingWrong", lang) };
      } finally {
        processingCalls.delete(callId);
      }
    }

    // ── PICKUP / DELIVERY ──────────────────────────────────
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
        await Order.updateOne({ _id: existingOrder._id }, {
          $set: {
            items: orderItems,
            deliveryAddress: orderDraft.deliveryAddress || existingOrder.deliveryAddress,
            orderType: orderDraft.orderType,
            customerName: draft.customerName,
            total, status: "confirmed",
          }
        });
      } else {
        const raceCheck = await Order.findOne({
          callId, orderType: orderDraft.orderType, status: "confirmed",
          createdAt: { $gte: new Date(Date.now() - 5000) },
        });
        if (!raceCheck) {
          await Order.create({
            callId, businessId: agent.businessId, agentId: agent._id,
            customerName: draft.customerName,
            customerPhone: draft.customerPhone || callerPhone,
            deliveryAddress: orderDraft.deliveryAddress || null,
            items: orderItems, orderType: orderDraft.orderType,
            scheduledTime: draft.requestedStart || null,
            total, status: "confirmed",
          });
          console.log("✅ Order saved:", orderDraft.orderType);
        }
      }

      await Call.updateOne({ _id: freshCall._id }, {
        $set: {
          "orderDraft.items": [], "orderDraft.orderType": null,
          "orderDraft.deliveryAddress": null, "orderDraft.status": "confirmed",
          "bookingDraft.customerName": null,
        }
      });

      const itemsSummary = orderDraft.items.map(i => `${i.name} x${i.quantity || 1}`).join(", ");
      const timeStr = draft.requestedStart
        ? new Date(draft.requestedStart).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Dubai" })
        : null;

      if (orderDraft.orderType === "delivery") {
        return { response: t("orderConfirmedDelivery", lang, itemsSummary, orderDraft.deliveryAddress, displayName, total) };
      }
      return { response: t("orderConfirmedPickup", lang, itemsSummary, displayName, timeStr, total) };
    }

    // ── FALLBACK HINTS ────────────────────────────────────
    if (orderDraft.orderType === "delivery" && orderDraft.items?.length > 0 && !orderDraft.deliveryAddress)
      return { response: t("askDeliveryAddress", lang) };
    if (orderDraft.orderType === "delivery" && orderDraft.items?.length > 0 && orderDraft.deliveryAddress && !draft.customerName)
      return { response: t("askOrderName", lang) };
    if (orderDraft.orderType === "pickup" && orderDraft.items?.length > 0 && !draft.requestedStart)
      return { response: t("askPickupTime", lang) };
    if (orderDraft.orderType === "pickup" && orderDraft.items?.length > 0 && !draft.customerName)
      return { response: t("askOrderName", lang) };
    if (orderDraft.orderType === "dineIn" && orderDraft.items?.length > 0 && !draft.partySize)
      return { response: t("askDiningPeople", lang) };
    if (orderDraft.orderType === "dineIn" && orderDraft.items?.length > 0 && draft.partySize && !draft.requestedStart)
      return { response: t("askDiningTime", lang) };
    if (orderDraft.orderType === "dineIn" && orderDraft.items?.length > 0 && draft.partySize && draft.requestedStart && !draft.customerName)
      return { response: t("askOrderName", lang) };
    if (bookingFlowActive && draft.partySize && draft.requestedStart && !draft.customerName && orderDraft.items?.length === 0)
      return { response: t("askName", lang) };

    return {
      response: aiResponse || t("howCanIHelp", lang),
      // If the AI itself responded with a goodbye, end the call
      ...(aiResponse && (
        /goodbye|have a (wonderful|great|good) day/i.test(aiResponse) ||
        /مع السلامة|وداعاً|يوماً رائعاً/.test(aiResponse)
      ) ? { end_call: true } : {}),
    };
  }

  // ── GOODBYE ───────────────────────────────────────────────
  if (looksLikeGoodbye(latestUserText)) {
    return { response: t("goodbye", lang), end_call: true };
  }

  // ── NOISE / VERY SHORT INPUT GUARD ────────────────────────
  // Retell sometimes sends background noise or 1-word utterances before
  // the customer actually speaks (e.g. ".عابس", "Welcome.", "(inaudible)").
  // If the transcript only has 0-1 turns and the text is very short or
  // inaudible, just greet and wait — do NOT trigger any flow.
  const isNoise =
    latestUserText.length < 4 ||
    /^\(inaudible/.test(latestUserText) ||
    /^[\.\!\?،,]+$/.test(latestUserText.trim());

  const transcriptLength = transcript?.length ?? 0;
  if (isNoise && transcriptLength <= 2) {
    return { response: t("howCanIHelp", lang) };
  }

  // ── GENERAL FALLBACK ──────────────────────────────────────
  const isJustGreeting = /^(hi|hello|hey|good morning|good evening|good afternoon|مرحبا|هلا|السلام عليكم|أهلاً|صباح الخير|مساء الخير|أهلين|هلو)[\s\?\!\.،]*$/i.test(latestUserText.trim());
  if (isJustGreeting && !orderDraft.items?.length && !orderDraft.orderType && !draft.partySize) {
    return { response: t("howCanIHelp", lang) };
  }

  const systemPrompt = buildSystemPrompt(agent, lang);
  const conversationHistory = transcript.slice(-6).map(t => ({
    role: t.role === "agent" ? "assistant" : "user",
    content: t.content,
  }));

  const aiReply = await getAIResponse([
    { role: "system", content: systemPrompt },
    ...conversationHistory,
    { role: "user", content: latestUserText || (lang === "ar" ? "مرحبا" : "Hello") },
  ]);

  // Bug fix: if AI response contains goodbye sentiment, end the call
  const aiSaysGoodbye = aiReply && (
    /goodbye|have a (wonderful|great|good) day/i.test(aiReply) ||
    /مع السلامة|وداعاً|يوماً رائعاً/.test(aiReply)
  );

  return {
    response: aiReply || t("howCanIHelp", lang),
    ...(aiSaysGoodbye ? { end_call: true } : {}),
  };
}

module.exports = { processLLMMessage };