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

// ─── BILINGUAL RESPONSES — Levantine Street Arabic ───────────────────────────
const R = {
  // Greetings / Generic
  howCanIHelp:        { en: "How can I help you today?",                                ar: "شو بدك؟" },
  somethingWrong:     { en: "Sorry, something went wrong.",                             ar: "في مشكلة، حاول مرة ثانية." },
  oneMovement:        { en: "One moment please...",                                     ar: "لحظة..." },
  goodbye:            { en: "Thanks for calling! Take care!",    ar: null }, // handled dynamically below
  anythingElse:       { en: "Is there anything else I can help you with?",              ar: "في شي ثاني؟" },
  sorryDidntCatch:    { en: "Sorry, I didn't catch that.",                              ar: "ما سمعتك، عيد معي؟" },

  // Booking
  bookingConfirmed:   (name, size, time) => ({
    en: `Perfect! Your table for ${size} is confirmed at ${time} under ${name}. Anything else?`,
    ar: `تمام يا ${name}! حجزنالك طاولة لـ${size} أشخاص الساعة ${time}. في شي ثاني؟`,
  }),
  bookingUpdated:     (name, size, time) => ({
    en: `Done! Updated your booking to ${size} people at ${time} under ${name}. Anything else?`,
    ar: `تمام! عدّلنا الحجز لـ${size} أشخاص الساعة ${time} باسم ${name}. في شي ثاني؟`,
  }),
  bookingCancelled:   { en: "Done! Your booking has been cancelled. Anything else?",    ar: "تمام، ألغينا الحجز. في شي ثاني؟" },
  noAvailability:     { en: "Sorry, we're fully booked at that time. Want a different time?", ar: "آسفين، ما في طاولة بهالوقت. بدك وقت ثاني؟" },
  suggestTime:        (time) => ({
    en: `We're full at that time. How about ${time} instead?`,
    ar: `الوقت هداك محجوز. كيف لو ${time}؟`,
  }),

  // Order
  orderConfirmedDelivery: (items, address, name, total) => ({
    en: `Perfect! ${items} on the way to ${address} for ${name}. Total: ${total} AED. Anything else?`,
    ar: `تمام يا ${name}! ${items} رايح يوصلك. المجموع ${total} درهم. في شي ثاني؟`,
  }),
  orderConfirmedPickup: (items, name, time, total) => ({
    en: `Got it! ${items} ready for pickup under ${name}${time ? ` at ${time}` : ""}. Total: ${total} AED. Anything else?`,
    ar: `تمام يا ${name}! الـ${items} جاهز للاستلام${time ? ` الساعة ${time}` : ""}. المجموع ${total} درهم. في شي ثاني؟`,
  }),
  orderConfirmedDineIn: (size, time, name, items, total) => ({
    en: `Perfect! Table for ${size} at ${time} under ${name}, and ${items} will be ready when you arrive. Total: ${total} AED. Anything else?`,
    ar: `تمام يا ${name}! حجزنالك طاولة لـ${size} الساعة ${time}، والـ${items} رح يكون جاهز لما توصل. المجموع ${total} درهم. في شي ثاني؟`,
  }),
  orderCancelled:     { en: "Done! Order cancelled. Anything else?",                    ar: "تمام، ألغينا الـ order. في شي ثاني؟" },
  orderTooOldCancel:  (mins) => ({
    en: `Sorry, your order was placed ${mins} minutes ago and can't be cancelled now.`,
    ar: `آسفين، الـ order صار عليه ${mins} دقيقة وما بينلغى هلق.`,
  }),
  orderTooOldModify:  (mins) => ({
    en: `Sorry, your order was placed ${mins} minutes ago and can't be modified now.`,
    ar: `آسفين، الـ order صار عليه ${mins} دقيقة وما بنتعدل هلق.`,
  }),

  // Questions — Booking
  askPartySize:       { en: "How many people will be joining?",          ar: "كم نفر؟" },
  askTime:            { en: "What time works for you?",                  ar: "أي ساعة؟" },
  askName:            { en: "What name should I put the booking under?", ar: "باسم مين؟" },
  askOrderName:       { en: "What name for the order?",   ar: "باسم مين نحط الـ order؟" },

  // Questions — Order
  askDeliveryAddress: { en: "What's the delivery address?",              ar: "وين بدنا نوصل؟" },
  askPickupTime:      { en: "What time will you pick up?",               ar: "أي ساعة رح تيجي؟" },
  askDiningTime:      { en: "What time would you like to come?",         ar: "أي ساعة رح تيجوا؟" },
  askDiningPeople:    { en: "How many people will be dining?",           ar: "كم نفر؟" },
  askNewAddress:      { en: "Sure! What's the new delivery address?",    ar: "أكيد! شو العنوان الجديد؟" },

  // Returning caller
  isThisYou:          (name) => ({
    en: `${name}? Is that you?`,
    ar: `${name}؟ أنت؟`,
  }),
  returningGreet:     (msg) => ({
    en: `Hey! ${msg} What can I do for you?`,
    ar: `هلا! ${msg} شو بقدر أساعدك؟`,
  }),
  notYou:             { en: "My bad! How can I help you?",               ar: "آسف! كيف بساعدك؟" },

  // Returning context
  returningBookingCtx: (size, time, name) => ({
    en: `I see a booking for ${size} people at ${time}.`,
    ar: `شايف عندك حجز لـ${size} أشخاص الساعة ${time}.`,
  }),
  returningOrderCtx:   (type, items, status) => ({
    en: `I see your ${type} order for ${items} — currently ${status}.`,
    ar: `شايف عندك ${items} — الـ status هلق: ${status}.`,
  }),

  // Name update
  nameUpdated:        (name) => ({
    en: `Done! Booking name updated to ${name}. Anything else?`,
    ar: `تمام! غيّرنا الاسم على ${name}. في شي ثاني؟`,
  }),
  askNewName:         { en: "What name for the booking?",                ar: "باسم مين بدك الحجز؟" },
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

// ─── ARABIC TEXT → ENGLISH FOR STORAGE ──────────────────────────────────────
// Common Arabic address/area words → English
const ARABIC_TO_ENGLISH_MAP = {
  // Areas
  'الشارقة': 'Sharjah', 'شارقة': 'Sharjah',
  'دبي': 'Dubai', 'أبوظبي': 'Abu Dhabi', 'ابوظبي': 'Abu Dhabi',
  'عجمان': 'Ajman', 'الفجيرة': 'Fujairah', 'رأس الخيمة': 'Ras Al Khaimah',
  'الخان': 'Al Khan', 'خان': 'Al Khan',
  'الميدان': 'Al Maidan', 'ميدان': 'Al Maidan',
  'الميدان السكني': 'Al Maidan Al Sakani',
  'بحيرة الخالد': 'Khalid Lake', 'النهدة': 'Al Nahda',
  'المجاز': 'Al Mujaz', 'الزاهية': 'Al Zahia',
  'الكورنيش': 'Corniche', 'المرية': 'Al Marija',
  // Building prefixes
  'بناية': 'Building', 'برج': 'Tower', 'فيلا': 'Villa',
  'شقة': 'Apt', 'طابق': 'Floor',
  // Notes
  'بدون خضار': 'no vegetables', 'بدون بصل': 'no onions',
  'بدون جبن': 'no cheese', 'بدون صوص': 'no sauce',
  'بدون ثوم': 'no garlic', 'بدون فلفل': 'no pepper',
  'حار': 'spicy', 'حار جداً': 'extra spicy',
  'إضافي': 'extra', 'اضافي': 'extra',
  'مشوي': 'grilled', 'مقلي': 'fried',
  'بدون': 'no', 'مع': 'with',
};

function translateToEnglishStorage(text) {
  if (!text) return text;
  let result = text;
  // Sort by length descending so longer phrases match first
  const entries = Object.entries(ARABIC_TO_ENGLISH_MAP).sort((a,b) => b[0].length - a[0].length);
  for (const [ar, en] of entries) {
    result = result.replace(new RegExp(ar, 'g'), en);
  }
  return result.trim();
}

// ─── ARABIC NAME TRANSLITERATION ──────────────────────────────────────────────
// Converts Arabic name to English equivalent for MongoDB storage
// Common Arabic names that need correct transliteration
const ARABIC_NAME_MAP = {
  'عبد الله': 'Abdullah', 'عبدالله': 'Abdullah',
  'عبد الرحمن': 'Abdulrahman', 'عبدالرحمن': 'Abdulrahman',
  'عبد العزيز': 'Abdulaziz', 'عبدالعزيز': 'Abdulaziz',
  'محمد': 'Mohammed', 'محمود': 'Mahmoud',
  'أحمد': 'Ahmad', 'احمد': 'Ahmad',
  'خالد': 'Khalid', 'فيصل': 'Faisal',
  'سلمى': 'Salma', 'سارة': 'Sara', 'فاطمة': 'Fatima',
  'يوسف': 'Yousef', 'عمر': 'Omar', 'علي': 'Ali',
  'نور': 'Nour', 'ريم': 'Reem', 'هند': 'Hind',
  'مريم': 'Mariam', 'لينا': 'Lina', 'دانة': 'Dana',
};

async function transliterateToEnglish(arabicText) {
  if (!arabicText) return arabicText;
  // Check common names first before calling GPT
  const trimmed = arabicText.trim();
  if (ARABIC_NAME_MAP[trimmed]) return ARABIC_NAME_MAP[trimmed];
  if (!arabicText || !containsArabic(arabicText)) return arabicText;
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
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

// Fuzzy menu item lookup — handles Arabic/English name mismatches
function findMenuItem(menu, itemName) {
  if (!menu?.length || !itemName) return null;
  const name = itemName.toLowerCase().trim();
  // 1. Exact match
  let found = menu.find(m => m.name.toLowerCase() === name);
  if (found) return found;
  // 2. Contains match (item name contains search or vice versa)
  found = menu.find(m => m.name.toLowerCase().includes(name) || name.includes(m.name.toLowerCase()));
  if (found) return found;
  // 3. Word overlap match — at least one word in common
  const searchWords = name.split(/s+/).filter(w => w.length > 2);
  found = menu.find(m => {
    const menuWords = m.name.toLowerCase().split(/s+/);
    return searchWords.some(sw => menuWords.some(mw => mw.includes(sw) || sw.includes(mw)));
  });
  return found || null;
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
      ? `أنت موظف استقبال في ${agent.businessName}. شخصيتك خفيفة ومريحة، بتحكي شامي عامي، وبتساعد الزبائن بطريقة طبيعية وإنسانية.`
      : `You are ${agent.agentName || "an AI receptionist"} at ${agent.businessName}. You are friendly, professional, and helpful.`;

  if (lang === "ar") {
    return `${basePrompt}

بتساعد الزبائن في: ${features.join("، ") || "الاستفسارات العامة"}.

شخصيتك — اقرأ هاد كويس:
- أنت زي شخص شغال بكاشير مطعم عادي — مش موظف فندق فاخر
- حكيك قصير جداً وطبيعي — جملة أو جملتين بالكتير
- ممنوع منعاً باتاً: "كيف يمكنني مساعدتك"، "يسعدني"، "وعليكم السلام ورحمة الله وبركاته"، "بكل سرور"، "تفضل سيدي"، "حضرتك"
- لما حدا يقول "مرحبا" قول "هلا!" أو "أهلين!" — مش خطبة
- لما حدا يقول "يعطيك العافية" قول "الله يعافيك" أو "تسلم" — مش أكثر
- لما حدا يقول "السلام عليكم" قول "وعليكم السلام" — بس هيك، مش "ورحمة الله وبركاته"
- بتخلط عربي وإنجليزي طبيعي: "شو بدك تـ order؟"، "الـ delivery رح يوصلك"، "الـ total كم"
- بتفهم كل اللهجات — خليجي، شامي، مصري — وبترد بنفس نكهة الشخص
- لو الزبون حكى بشكل كاجوال، ارد كاجوال
- لو قالك "هلا والله" قول "هلا فيك!" — مش خطبة ترحيب
- ردودك قصيرة جداً — الزبون على التلفون مش عنده وقت يسمع كلام زيادة

أوقات العمل:
${formatOpeningHours(agent.openingHours)}

${hasOrders && agent.menu?.length > 0 ? `المنيو:\n${formatMenu(agent.menu)}` : ""}

القواعد:
- سؤال واحد بس بكل رد — مش سؤالين بنفس الرد
- لا تطلب رقم التلفون أبداً
- الحجوزات بالوقت بس، مو التاريخ
- إذا ما في الصنف بالمنيو، قول "ما عنا هيك" ببساطة — لكن انتبه: "سبايسي"، "حار"، "بدون خضار"، "عادي" هي ملاحظات وليست أصناف، لا تقول "ما عنا" عليها أبداً
- لا تقترح طلب أكل بعد ما تأكد الحجز
- لا تقرأ المنيو كله — إذا قال "بدي أطلب" قول "شو بدك؟" بس
- إذا سألك "شو عندكم؟" قول مثلاً "شاورما، زنجر، عصير وأكثر — شو بيشتهيك؟"`;
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
- Always be warm and welcoming
- NEVER read the full menu aloud — if customer says "I want to order" just say "What would you like?"
- If asked "what do you have?", give a brief summary like "We have shawarma, burgers, zinger and more — what sounds good?"`;
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
    ? `The customer is speaking Arabic (possibly mixed with English). You MUST:
- Understand BOTH Gulf Arabic (يبي، أبغى، وين، كيف حالك) AND Levantine Arabic (بدي، وين، كيفك، يلا، ماشي) — respond in Levantine only
- Understand mixed sentences naturally: "بدي delivery"، "متى رح يوصل الـ order؟"، "بدي اطلب pickup"، "كم الـ total؟"، "في شي بالـ menu؟"
- English words inside Arabic are normal: order، delivery، pickup، total، menu، table، booking — extract them correctly
- Understand Arabic numbers: واحد=1, اثنين=2, ثلاثة=3, أربعة=4, خمسة=5, ستة=6, سبعة=7, ثمانية=8, تسعة=9, عشرة=10
- Understand Arabic time: "الساعة سبعة" = 7:00, "الساعة سبعة ونص" = 7:30, "بعد ساعة" = in 1 hour, "بعد نص ساعة" = in 30 minutes
- Understand order types in any form:
  * delivery: "توصيل"، "يوصلوا"، "delivery"، "بدي delivery"، "دليفري"
  * pickup: "استلام"، "آخذه"، "pickup"، "أجي آخذه"، "تيك اواي"
  * dineIn: "نجلس"، "نأكل هناك"، "أكل داخل"، "dine in"، "دايني"
- Extract Arabic names as-is (they will be transliterated separately)
- CRITICAL: أشخاص، شخص، ناس، أفراد are party size words NOT names
- CRITICAL: أربعة، ثلاثة، اثنين are numbers/party sizes NOT names
- A name is a proper noun: محمود، سارة، أحمد، خالد، فاطمة
- Understand Arabic addresses and locations
- Understand corrections: "لا قصدي"، "مو كذا"، "غلط" = correction — "إلغي"، "ألغي" = cancel — "غيّر"، "بدّل" = modify
- ردودك MUST تكون قصيرة جداً — جملة واحدة فقط
- اسلوبك: شخص شغال بكاشير مطعم عادي، مش موظف فندق
- ممنوع: "كيف يمكنني"، "يسعدني"، "بكل سرور"، "تفضل سيدي"، أي شي رسمي
- أمثلة صح: "شو بدك؟"، "توصيل ولا استلام؟"، "باسم مين؟"، "أي ساعة؟"، "وين؟"، "تمام!"، "رقم الشقة؟"
- أمثلة غلط: "بكل سرور سأساعدك"، "كيف يمكنني مساعدتك اليوم"، "شكراً لتواصلك معنا"، "وين اسمك؟"، "ما اسمك؟"
- NEVER say "وين اسمك؟" — always say "باسم مين؟" when asking for name
- لما الزبون يحكي بشكل كاجوال، ارد بشكل أكثر كاجوال منه
- JSON keys stay in English always`
    : `The customer is speaking English. Respond in English, casual and friendly.`;

  const prompt = `You are a receptionist at ${agent.businessName}.
Current time in Dubai: ${currentTimeStr}
${langNote}

Current state:
- Booking: people=${currentDraft.partySize ?? "not collected"}, time=${currentDraft.requestedStart ? new Date(currentDraft.requestedStart).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:true,timeZone:"Asia/Dubai"}) : "not collected"}, name=${currentDraft.customerName ?? "not collected"}
- Order: items=${orderDraft.items?.length > 0 ? orderDraft.items.map(i=>`${i.name}x${i.quantity}${i.notes ? "("+i.notes+")" : ""}`).join(",") : "none"}, type=${orderDraft.orderType ?? "not set"}, address=${(orderDraft.deliveryAddress && orderDraft.deliveryAddress !== "null") ? orderDraft.deliveryAddress : "not collected"}, notes=${orderDraft.notes ?? "none"}
${returningInfo}

${menuText}

Recent conversation:
${recentConvo}

Customer just said: "${text}"

STRICT RULES:
- Current time is ${currentTimeStr}. When customer says relative time ("in X minutes", "بعد ساعة", "after X hours"), calculate actual time from current Dubai time and return HH:MM 24hr.
- If customer says "book a table" or "احجز طاولة" with NO food items mentioned, this is BOOKING ONLY. Do NOT set orderType. Do NOT ask about order type.
- NEVER set orderType to "dineIn" for a pure table reservation with no food items ordered.
- orderType ONLY when customer EXPLICITLY says delivery/pickup/dine-in — NEVER guess:
  * "توصيل"/"delivery"/"ابعتوه" = "delivery"
  * "استلام"/"pickup"/"تيك اواي" = "pickup"
  * "نجلس"/"dine in"/"نأكل هناك" = "dineIn" (ONLY with food items)
  * "الاثنين بدون خضار" = null (item notes, NOT orderType)
  * "كلهم حار" = null (item notes, NOT orderType)
  * If no explicit delivery/pickup/dineIn word → orderType MUST be null
- partySize: BOOKING ONLY — number of people for table reservation:
  * "الاثنين يكونوا بدون خضار" → partySize = null (الاثنين = both ITEMS)
  * "كلهم" → partySize = null (refers to items)
  * "أربعة أشخاص"/"4 people" during booking → partySize = 4
  * ONLY set partySize when customer mentions people/guests for a table
- For names: extract ONLY proper names (محمود، سارة، Ahmed، etc). Store as-is.
- CRITICAL: NEVER extract sentences or phrases as names. These are NOT names:
  * "أنا لسه حاكيلك" — this means "I'm still talking to you", NOT a name
  * "لسه" / "بس" / "آه" / "حاكيلك" — filler words, NOT names
  * Any phrase longer than 3 words is almost certainly NOT a name
  * Sentences starting with "أنا" (I) are NEVER names
  * Words related to addresses are NEVER names: برج، بناية، شقة، طابق، السكني، الميدان، المدينة، الخان
  * If the "name" contains any building/address words → it is NOT a name, return null
  * If you're unsure, return null for name
- CRITICAL: Words like أشخاص، شخص، ناس are party size words NOT names. Numbers like أربعة، ثلاثة are NOT names.
- For Arabic numbers in party size: convert to integer (ثلاثة = 3, أربعة = 4, etc.)
- For addresses (CRITICAL):
  * Format: "unit, building, area, city" e.g. "206, Al Maidan 2, Al Khan, Sharjah"
  * ARABIC NUMBER WORDS → must convert to digits in addresses:
    - واحد=1, اثنين=2, ثلاثة=3, عشرة=10, عشرين=20, ثلاثين=30, أربعين=40, خمسين=50
    - مية=100, ميه=100, مئة=100, مئتين=200, متين=200, ثلاثمية=300, أربعمية=400, خمسمية=500
    - "متين وستة" = 206, "مية وعشرين" = 120, "ثلاثمية وخمسة" = 305
  * Building names: "الميدان السكني"="Al Maidan Al Sakani", "الميدان ثاني"="Al Maidan 2", "برج X"="Tower X"
  * CRITICAL: "اسم البناية" / "اسم البناي" / "اسم البرج" are LABEL WORDS meaning "building name is..." — they are NOT the actual building name
  * When customer says "اسم البناية الميدان السكني" → building name is "Al Maidan Al Sakani", NOT "اسم البناية"
  * When customer says "رقم الشقة 206" → unit is 206, NOT "رقم الشقة 206"
  * Strip label words and extract only the actual value after them
  * UAE AREA → CITY (MEMORIZE — never assume Dubai by default):
    - الخان / Al Khan / خان → SHARJAH (NOT Dubai)
    - بحيرة الخالد / Khalid Lake → SHARJAH
    - النهدة الشارقة → SHARJAH
    - المجاز / Mujaz → SHARJAH
    - الزاهية / Zahia → SHARJAH
    - JVC, JBR, Marina, Downtown, Deira, Bur Dubai, Jumeirah, مردف → DUBAI
    - النهدة دبي → DUBAI
    - عجمان / Ajman → AJMAN
    - الأهرامات / Al Ahramat / Al Ahramat Building → AJMAN (this is in Ajman, NOT Sharjah)
    - النعيمية / Al Nuaimiya → AJMAN
    - الروضة / Al Rawda → AJMAN (Ajman)
    - مويهات / Muwaileh → SHARJAH
    - رأس الخيمة / RAK → RAS AL KHAIMAH
    - العين / Al Ain → ABU DHABI
  * ALWAYS infer city from area — never default to Dubai if area suggests another city
  * Missing info rules:
    - Customer gave ONLY area (no building) → ask "شو اسم البناية؟"
    - Customer gave area + building (no unit) → SAVE area+building, ask "رقم الشقة أو الوحدة؟"
    - Customer gave building + unit (no area/city) → SAVE it, infer city if possible
    - Customer gave all three → SAVE immediately, return as address
  * NEVER ask again for info the customer already gave
- For item notes (CRITICAL — accept at ANY point in the conversation):
  * Extract ANY customization the customer mentions for a specific item AT ANY TIME
  * Store notes as SHORT KEYWORDS ONLY — not full sentences. The kitchen needs quick instructions.
  * Notes are ONLY real customizations — things that change how the item is prepared
  * Examples of CORRECT notes: "no vegetables", "no onions", "extra sauce", "spicy", "no cheese", "well done", "extra spicy"
  * Examples of WRONG notes — do NOT save these:
    - "عادي" / "normal" / "regular" / "عادية" = means NO customization, save as null not as a note
    - Full sentences: "هل يمكن الشاورما بدون خضار؟" → extract just "no vegetables"
    - Filler words: "please", "لو سمحت", "من فضلك" → strip these completely
  * ALL notes must be in ENGLISH:
    - "بدون خضار" → "no vegetables"
    - "بدون بصل" → "no onions"  
    - "بدون جبن" → "no cheese"
    - "حار" / "سبايسي" → "spicy"
    - "حار جداً" → "extra spicy"
    - "بدون صوص" → "no sauce"
    - "مشوي" → "grilled"
    - "بدون ثوم" → "no garlic"
  * If customer says "واحد سبايسي وواحد عادي" → extract as TWO separate items: first with notes="spicy", second with notes=null
  * Multiple notes per item ARE allowed — combine them with comma
  * Extract ANY customization the customer says — don't limit to a predefined list.
    Whatever the customer requests for an item, extract it as a short keyword in English.
    
  * COMBINING SHARED + INDIVIDUAL NOTES — the most critical rule:
    Step 1: Identify SHARED notes (apply to ALL items of that type)
    Step 2: Identify INDIVIDUAL notes (apply to specific items only)
    Step 3: Each item's final notes = shared notes + its individual note, combined with comma
    
    Example: "الاثنين بدون خضار وزيادة جبن، واحدة سبايسي والثانية دبس رمان"
    → Shared notes for both Zingers: "no vegetables, extra cheese"
    → Item 1 individual: "spicy"  → Final: "no vegetables, extra cheese, spicy"
    → Item 2 individual: "pomegranate molasses"  → Final: "no vegetables, extra cheese, pomegranate molasses"
    
    CRITICAL: "واحدة سبايسي" means ONE OF THEM IS SPICY — do NOT write "no spicy" for the other one.
    If a note is not mentioned for an item, simply don't include it — don't write "no X" unless customer explicitly said "بدون X".
    
  * Extract EXACTLY what the customer said — if they said "سبايسي" write "spicy", never "no spicy"
  * Only write "no X" when customer explicitly says "بدون X" or "without X"
  * Keep notes SHORT — strip filler words, keep only the instruction
  * Translate Arabic notes to English: بدون خضار=no vegetables, حار/سبايسي=spicy, زيادة جبن=extra cheese, دبس رمان=pomegranate molasses, طحينية=tahini, زيادة صوص=extra sauce, بدون بصل=no onions
  * NEVER drop a note — if customer said it, it MUST appear in the JSON
  * Multiple notes on one item → comma separated: "no vegetables, extra cheese, spicy"
  * These go in the item's "notes" field — update the relevant item even if mentioned earlier
  * NEVER ignore real customization requests
- For address corrections (CRITICAL):
  * If customer says the address is wrong or gives a correction ("لا مو صح"، "غلط"، "actually it's in Sharjah"، "هي في الشارقة"), extract the CORRECTED address
  * Always prefer the most recent address the customer gives
  * When customer corrects city/area, update the full address with the correct city
- For order notes: general instructions not specific to one item (e.g. "اطرق الباب مرتين", "اتصل لما توصل", "leave at the door")
- Never ask for phone number
- Never mention dates, only times
- CRITICAL: NEVER return a confirmation message in your response. The system handles confirmations.
- CRITICAL: All extracted DATA (names, addresses, notes) must be in ENGLISH in the JSON fields.
  * Arabic name "محمود" → store as "Mahmoud" in the name field
  * Arabic area "الشارقة" → store as "Sharjah" in deliveryAddress
  * Arabic note "بدون خضار" → store as "no vegetables" in notes field
  * Your "response" field (what the agent says) stays in Arabic if customer speaks Arabic
  * But all JSON data fields must be in English for the restaurant staff
- CRITICAL: ONLY extract items that EXACTLY match the menu list above. Never invent item names.
- The transcriber mishears — use these mappings to fix common mishearings:
  * "ساندويتش" / "sandwich" alone (without "shawarma") → most likely "Zinger Sandwich"
  * "شاورما" → "Shawarma Arabi"
  * "عصير عبود" / "عبود جوز" → "Abood Juice"
  * "chicken sandwish" / "chicken sandwich" → check if "Zinger Sandwich" or "Chicken Sandwich" is on the menu
  * When unsure between two menu items, pick the one that sounds closest
- CRITICAL: "spicy", "سبايسي", "حار", "extra", "بدون", "plain", "normal", "عادي" are CUSTOMIZATIONS/NOTES, NOT menu items.
- If customer says "واحد سبايسي وواحد بدون خضار" for Zinger → extract TWO Zinger Sandwich items:
  [{"name":"Zinger Sandwich","quantity":1,"notes":"spicy"},{"name":"Zinger Sandwich","quantity":1,"notes":"no vegetables"}]
- NEVER extract only one note when customer mentioned two different customizations for two items
- Required for booking: partySize + time + name. If ANY missing, ask for it.
- Required for delivery: items + COMPLETE address (area + building + unit) + name. Ask for each missing piece.
- CRITICAL: If orderType is already set in the current state, NEVER ask about it again. Go straight to the next missing piece.
- CRITICAL: For delivery orders with no time specified, assume the customer wants it NOW — do not ask for time.
- CRITICAL: If customer said "I want 1 shawarma for delivery" in ONE sentence, you already have items + orderType. Just ask for address next.
- Required for pickup: items + time + name. Ask for each missing piece.
- If all required info collected, return null for response.
- intent: "cancel" if customer wants to cancel, "modify" if wants to change, "new" otherwise

Respond ONLY with valid JSON (no markdown):
{
  "extracted": {"partySize": <number or null>, "time": "<HH:MM 24hr or null>", "name": "<string or null>"},
  "orderExtracted": {
    "items": [{"name": "<EXACT menu name>", "quantity": <number>, "extras": [], "notes": "<item customization or null>"}],
    "orderType": "<dineIn|pickup|delivery|null>",
    "deliveryAddress": "<unit, building, area, city — or null (JSON null, NOT the string 'null') if incomplete>",
    "notes": "<order-level notes or null>"
  },
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
        model: "gpt-4o-mini",
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
    /إلغ|ألغي|امسح|لا أريد|ما أبي|بطّل|ما طلبت|مو طلبت|شيل/.test(text);
}
function looksLikeModifyIntent(text) {
  if (!text) return false;
  return /\b(change|modify|update|edit|make it|instead|switch|different|wrong|correct|fix|actually|remove|delete|take off|without)\b/i.test(text) ||
    /غيّر|بدّل|عدّل|مو كذا|قصدي|لا لا|أقصد|اصلاً|شيل|احذف|ما طلبت|مو طلبت|بدون/.test(text);
}
function looksLikeGoodbye(text, transcript, orderConfirmed, bookingConfirmed) {
  if (!text) return false;

  // Hard goodbye — always end call immediately
  const hardGoodbye =
    /\b(bye|goodbye|bye bye|that's all|nothing else|no thank)\b/i.test(text) ||
    /مع السلام[ةه]|السلام[ةه]|وداع[اً]|بس كذا|ما في غير|باي\b/.test(text);

  if (hardGoodbye) return true;

  // Soft phrases — "thank you", "شكراً", "يعطيك العافية", "لا شكراً"
  // These are ONLY goodbyes when:
  // 1. Something was confirmed (order or booking) — most reliable signal
  // 2. OR conversation is substantial (8+ turns) AND no new intent in message
  const softGoodbye =
    /\b(thank you|thanks|no thank|no thanks)\b/i.test(text) ||
    /^لا[،,]?\s*شكر/i.test(text) ||
    /^لا،?\s*مشكور/i.test(text) ||
    /^بس\s*شكر/i.test(text) ||
    /يسلموا|يعطيك العافي[ةه]|الله يعافيك|تصبح على خير/.test(text);

  // "شكراً" alone — only goodbye if confirmed or very late in conversation
  const shukran = /^شكر[اً]?[\s\.،]*$/.test(text.trim());

  if (softGoodbye || shukran) {
    const turns = transcript?.length ?? 0;
    const somethingConfirmed = orderConfirmed || bookingConfirmed;

    // After a confirmed booking/order — these phrases = goodbye
    if (somethingConfirmed && turns >= 4) return true;

    // Very late in long conversation with no booking/order — probably goodbye
    if (turns >= 10) return true;

    // Too early in conversation — could be a greeting, not goodbye
    return false;
  }

  return false;
}

// ─── DYNAMIC GOODBYE BUILDER ─────────────────────────────────────────────────
// Mirrors the customer's goodbye style instead of always saying the same thing
function buildGoodbye(text, lang) {
  if (lang === "ar") {
    if (/مع السلامة/i.test(text)) {
      const options = ["حياك الله!", "الله يسلمك!", "شكراً، مع السلامة!"];
      return options[Math.floor(Math.random() * options.length)];
    }
    if (/يعطيك العافية|الله يعافيك/i.test(text)) return "الله يعافيك!";
    if (/شكر/i.test(text)) return "تسلم! مع السلامة.";
    if (/باي|bye/i.test(text)) return "باي باي!";
    if (/لا شكراً|لا، شكراً|no thank/i.test(text)) return "تسلم! مع السلامة.";
    // default short Arabic goodbye
    return "مع السلامة!";
  } else {
    if (/bye/i.test(text)) return "Bye!";
    if (/thank/i.test(text)) return "Thanks! Take care!";
    if (/no thank/i.test(text)) return "Sure! Take care!";
    return "Take care! Goodbye!";
  }
}

// ─── NATURAL ITEMS SUMMARY BUILDER ──────────────────────────────────────────
// Builds natural language item summaries without "x1" notation
// Arabic: "شاورما عربي وزنجر ساندويش اثنين"
// English: "1 Shawarma Arabi and 2 Zinger Sandwiches"
function buildItemsSummary(items, menu, lang) {
  if (!items?.length) return "";
  // Consolidate items with same name — group by name, sum quantities
  const grouped = {};
  for (const i of items) {
    const key = i.name;
    if (!grouped[key]) grouped[key] = { ...i, quantity: 0 };
    grouped[key].quantity += (i.quantity || 1);
  }
  const consolidated = Object.values(grouped);
  const qtyWords = { 1:"", 2:"اثنين", 3:"ثلاثة", 4:"أربعة", 5:"خمسة", 6:"ستة", 7:"سبعة", 8:"ثمانية", 9:"تسعة", 10:"عشرة" };
  const parts = consolidated.map(i => {
    const qty = i.quantity || 1;
    const name = i.name;
    if (lang === "ar") {
      const menuItem = menu?.find(m => m.name.toLowerCase() === name.toLowerCase());
      const arName = menuItem?.nameAr || menuItem?.arabicName || name;
      if (qty === 1) return arName;
      return `${arName} ${qtyWords[qty] || qty}`;
    } else {
      if (qty === 1) return name;
      return `${qty} ${name}`;
    }
  });
  if (parts.length === 1) return parts[0];
  if (lang === "ar") return parts.join(" و");
  return parts.slice(0,-1).join(", ") + " and " + parts[parts.length-1];
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

  // Note: deduplication is handled in llmSocket.js via response_id tracking

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
  const detectedNow  = detectLanguage(latestUserText);
  const storedLang   = freshCall.meta?.lang;
  const callAge      = Date.now() - new Date(freshCall.createdAt).getTime();
  const withinCall   = callAge < 30 * 60 * 1000;

  // Agent's configured language in MongoDB (agent.language = "Arabic" or "English")
  // This is the DEFAULT language for this restaurant — used for greetings and fallback
  const agentLangSetting = (agent.language || "English").toLowerCase();
  const agentDefaultLang = agentLangSetting.includes("arab") ? "ar" : "en";

  let lang;

  // Arabic chars are unambiguous — always trust them regardless of length
  const hasArabicChars = /[\u0600-\u06FF]/.test(latestUserText);

  // Short English fillers that may appear during an Arabic conversation
  // English fillers that should NOT cause language flip during Arabic conversation
  // Includes number words spoken in English (e.g. "two zero six" for apartment number)
  // Pure numbers, digits, or English number words spoken mid-Arabic-call (e.g. "206", "two zero six")
  // should NEVER flip the language — customer is just giving a number like an apartment number
  const numberWords = /^(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|hundred|thousand)(\s+(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|hundred|thousand))*$/i;
  const strippedForNumber = latestUserText.trim().replace(/[\.\!\?،,]+$/, ''); // strip trailing punctuation
  const isPureNumber = /^[\d\s]+$/.test(strippedForNumber) || numberWords.test(strippedForNumber);
  const isEnglishFiller = /^(ok|okay|yes|no|yeah|nope|hi|hey|hello|sure|great|thanks|bye|good|fine|right|hmm|uh|ah|oh)[\s\.\!\?]*$/i.test(latestUserText.trim()) || isPureNumber;

  if (hasArabicChars) {
    lang = "ar";
  } else if (detectedNow === "en" && isEnglishFiller && storedLang === "ar") {
    lang = "ar"; // short English filler during Arabic conversation — stay Arabic
  } else if (detectedNow) {
    lang = detectedNow;
  } else if (storedLang && withinCall) {
    lang = storedLang;
  } else {
    lang = agentDefaultLang; // fall back to restaurant's configured language
  }

  // Explicit switch requests always override
  const explicitArabic  = /تكلم عربي|بالعربي|عربي بس|كلمني عربي/i.test(latestUserText) ||
    /\b(speak arabic|talk arabic|in arabic|arabic please|switch to arabic|talk in arabic|speak in arabic)\b/i.test(latestUserText);
  const explicitEnglish = /\b(speak english|in english|english please|talk english|switch to english)\b/i.test(latestUserText);
  if (explicitArabic)  lang = "ar";
  if (explicitEnglish) lang = "en";

  // Only persist language if it's a REAL language signal, not just a number
  // Numbers ("304", "206") are not language signals — don't let them flip stored lang
  const isJustNumber = isPureNumber;
  if (lang !== storedLang && !isJustNumber) {
    await Call.updateOne({ _id: freshCall._id }, { $set: { "meta.lang": lang } });
  } else if (isJustNumber && storedLang) {
    // Number spoken — restore to stored language, don't flip
    lang = storedLang;
  }
  console.log(`🌐 Language: ${lang} (hasArabic: ${hasArabicChars}, stored: ${storedLang || "none"}, default: ${agentDefaultLang})`);

  // ── FIRST TURN GREETING ───────────────────────────────────
  // Retell sends response_required before the customer speaks.
  // Return a clean one-line greeting immediately — no GPT call, no cutoff.
  const isFirstTurn = transcript.length === 0 || (transcript.length === 1 && transcript[0]?.role === "agent");
  const isNoisyInput = !latestUserText || latestUserText.length < 3 || /^[.!?,،s]+$/.test(latestUserText.trim());

  if (isFirstTurn && isNoisyInput && !storedLang) {
    const greeting = lang === "ar"
      ? `أهلاً وسهلاً في ${agent.businessName}! شو بقدر أساعدك؟`
      : `Hello! Welcome to ${agent.businessName}. How can I help you?`;
    return { response: greeting };
  }

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
    deliveryAddress: (freshCall.orderDraft?.deliveryAddress && freshCall.orderDraft.deliveryAddress !== "null") ? freshCall.orderDraft.deliveryAddress : null,
    notes:           freshCall.orderDraft?.notes           ?? null,
  };

  // If we're in "adding to order" mode, treat as active order flow even with empty items
  const isAddingToOrder = freshCall.meta?.addingToOrder === true;

  // CRITICAL: If orderDraft is empty (add flow reset it) but there's a confirmed
  // order in this call, restore ONLY orderType/address/name — NOT items
  // Items must start empty so the merge doesn't double-count
  if (orderDraft.items.length === 0 && !orderDraft.orderType && orderDraft.status !== "confirmed") {
    const priorOrder = await Order.findOne({ callId, status: { $in: ["confirmed","preparing"] } }).sort({ createdAt: -1 }).lean();
    if (priorOrder) {
      orderDraft.orderType       = priorOrder.orderType;
      orderDraft.deliveryAddress = priorOrder.deliveryAddress;
      orderDraft.notes           = null; // fresh notes for new addition
      if (!draft.customerName) draft.customerName = priorOrder.customerName;
      // DO NOT restore items — they live in the DB order and will be merged at save time
      console.log(`🔄 Restored context from prior order: ${priorOrder.orderType}, ${priorOrder.deliveryAddress}`);
    }
  }

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

  // Check if there's already a confirmed order in THIS call — never trigger returning caller then
  const thisCallConfirmedOrder = await Order.findOne({ callId, status: { $in: ["confirmed","preparing","ready"] } }).lean();
  if (callerPhone && mentionsChange && !awaitingReturnConfirmation && !returnConfirmed && !hasActiveDraftOrConfirmed && !thisCallConfirmedOrder) {
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

    // Break out of confirmation loop after 2 failed attempts or if customer clearly wants to do something new
    const confirmAttempts = freshCall.meta?.confirmAttempts ?? 0;
    const customerWantsAction = looksLikeOrderIntent(latestUserText) || looksLikeBookingIntent(latestUserText);

    if (confirmAttempts >= 2 || customerWantsAction) {
      await Call.updateOne({ _id: freshCall._id }, {
        $set: {
          "meta.awaitingReturnConfirmation": false,
          "meta.returnConfirmed":            false,
          "meta.confirmAttempts":            0,
        }
      });
      return { response: lang === "ar" ? "تمام! شو بقدر أساعدك؟" : "No problem! How can I help you?" };
    }

    await Call.updateOne({ _id: freshCall._id }, { $inc: { "meta.confirmAttempts": 1 } });

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

  // partySize extracted from "الاثنين/both/all" in an order context is NOT a booking signal
  // Clear it if we already have order items
  if (draft.partySize && orderDraft.items?.length > 0) {
    draft.partySize = null;
  }

  const bookingFlowActive =
    (!!draft.partySize && orderDraft.items?.length === 0) || // only booking if no order items
    !!draft.requestedStart ||
    (!returnConfirmed && !!draft.customerName && orderDraft.items?.length === 0) ||
    looksLikeBookingIntent(latestUserText) ||
    looksLikeBookingIntent(recentTranscriptText);

  const orderFlowActive =
    agent.features?.orders === true && (
      !!orderDraft.items?.length || !!orderDraft.orderType ||
      isAddingToOrder ||  // in add-to-order flow, always treat as order active
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
    if (looksLikeGoodbye(latestUserText, transcript, orderDraft.status === "confirmed", !!justConfirmedBooking)) {
      return { response: buildGoodbye(latestUserText, lang), end_call: true };
    }
    // "لا" or "no" alone after confirmed order = goodbye
    const isSimpleNo = /^(لا|no|nope|لأ|بس|bas|that's it|done|هيك|هيك بس|بس هيك|يلا|خلص|خلاص|تمام بس|إن شاء الله|انشالله|ان شاء الله|okay|ok)[\s\.\!\?،]*$/i.test(latestUserText.trim()) ||
      /^(خلاص|طيب خلاص|خلاص هذا|طيب)[\s\.,،!؟]*$/i.test(latestUserText.trim());
    if (isSimpleNo) {
      return { response: buildGoodbye(latestUserText, lang), end_call: true };
    }
    if (looksLikeOrderIntent(latestUserText) && !modifyIntent && !cancelIntent) {
      // Reset order draft and fall through to active flow — don't return "anything else?"
      orderDraft = { items: [], orderType: null, status: null, deliveryAddress: null, notes: null };
      await Call.updateOne({ _id: freshCall._id }, {
        $set: {
          "orderDraft.items":           [],
          "orderDraft.orderType":       null,
          "orderDraft.status":          null,
          "orderDraft.deliveryAddress": null,
          "orderDraft.notes":           null,
        }
      });
      // Fall through — don't return, let the active flow handle it immediately
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
        // CRITICAL: preserve the customer name — do NOT clear it on address correction
        if (existingOrder.customerName && !draft.customerName) {
          draft.customerName = existingOrder.customerName;
        }
        await Call.updateOne({ _id: freshCall._id }, {
          $set: {
            "orderDraft.items":           existingOrder.items,
            "orderDraft.orderType":       existingOrder.orderType,
            "orderDraft.deliveryAddress": mentionsAddress ? null : existingOrder.deliveryAddress,
            "orderDraft.status":          null,
            // Restore customer name if we have it
            ...(existingOrder.customerName ? { "bookingDraft.customerName": existingOrder.customerName } : {}),
          }
        });
        if (mentionsAddress) return { response: lang === "ar" ? "آسف على ذلك! شو العنوان الصحيح؟ رقم الشقة، اسم البرج، المنطقة." : "Sorry! What's the correct address?" };
      }
    } else {
      const existingOrder = await Order.findOne({ callId, status: { $in: ["confirmed","preparing"] } }).sort({ createdAt: -1 });

      // If customer is adding new items (not just notes), re-open add flow
      const isNewItemAddition = (
        /بدي أضيف|بقدر أضيف|ممكن أضيف|كمان وحدة|كمان اثنين|add another|i want to add|want to add/i.test(latestUserText) ||
        (looksLikeOrderIntent(latestUserText) && !/بدون|without|no |extra|حار|spicy|سبايسي|خضار|بصل|جبن|صوص|طحينية|tahini/i.test(latestUserText))
      );
      if (isNewItemAddition && existingOrder) {
        const preservedType    = existingOrder.orderType;
        const preservedAddress = existingOrder.deliveryAddress;
        const preservedName    = existingOrder.customerName || draft.customerName;
        orderDraft.items = []; orderDraft.status = null;
        orderDraft.orderType = preservedType; orderDraft.deliveryAddress = preservedAddress;
        draft.customerName = preservedName;
        await Call.updateOne({ _id: freshCall._id }, { $set: {
          "orderDraft.items": [], "orderDraft.status": null,
          "orderDraft.orderType": preservedType,
          "orderDraft.deliveryAddress": preservedAddress,
          "bookingDraft.customerName": preservedName,
        }});
        return { response: lang === "ar" ? "أكيد! شو بدك تضيف؟" : "Sure! What would you like to add?" };
      }

      // Check if customer is correcting the address
      const mentionsAddressCorrection = /غلط|مو صح|مش صح|لا مو|لأ مو|لا اصلاً|مش كذا|مش هيك|العنوان غلط|no it's|wrong|not right|actually|it's in|انها في|هي في|في الشارقة|في دبي|في ابوظبي|في عجمان|في عجمان|بدل|حط بدل|غير ال|replace|change.*address|عنوان ثاني|عنوان جديد/i.test(latestUserText);
      if (mentionsAddressCorrection && existingOrder) {
        const mins = (Date.now() - new Date(existingOrder.createdAt).getTime()) / 60000;
        if (mins <= 5) {
          // Re-open the order flow to collect corrected address
          orderDraft.items           = existingOrder.items;
          orderDraft.orderType       = existingOrder.orderType;
          orderDraft.deliveryAddress = null; // clear wrong address
          orderDraft.status          = null;
          await Call.updateOne({ _id: freshCall._id }, {
            $set: {
              "orderDraft.items":           existingOrder.items,
              "orderDraft.orderType":       existingOrder.orderType,
              "orderDraft.deliveryAddress": null,
              "orderDraft.status":          null,
            }
          });
          return { response: lang === "ar" ? "آسف على ذلك! شو العنوان الصحيح؟ رقم الشقة، اسم البرج، المنطقة والمدينة." : "Sorry about that! What's the correct address? Apartment number, building name, area and city." };
        }
      }

      // Check if customer wants to remove an item from confirmed order
      // Quantity correction — "الزنجر اثنين بس" = fix qty to 2
      const mentionsQtyCorrection = /\b(بس|only|just|فقط|هم|هن)\b/i.test(latestUserText) &&
        /\d+|واحد|اثنين|ثلاثة|أربعة|خمسة/.test(latestUserText);
      if (mentionsQtyCorrection && existingOrder) {
        const mins = (Date.now() - new Date(existingOrder.createdAt).getTime()) / 60000;
        if (mins <= 10) {
          const { orderExtracted: corrEx } = await extractAndRespond(latestUserText, draft, orderDraft, transcript, agent, null, lang);
          if (corrEx?.items?.length > 0) {
            const correctedItems = existingOrder.items.map(i => i.toObject ? i.toObject() : {...i});
            for (const corrItem of corrEx.items) {
              const idx = correctedItems.findIndex(e => e.name.toLowerCase() === corrItem.name.toLowerCase());
              if (idx >= 0) correctedItems[idx].quantity = corrItem.quantity;
            }
            const corrTotal = correctedItems.reduce((sum, item) => {
              const mi = findMenuItem(agent.menu, item.name);
              return sum + (mi?.price || 0) * (item.quantity || 1);
            }, 0);
            await Order.updateOne({ _id: existingOrder._id }, { $set: { items: correctedItems, total: corrTotal } });
            return { response: lang === "ar" ? "تمام، عدّلنا الطلب. في شي ثاني؟" : "Done! Updated. Anything else?" };
          }
        }
      }

      const mentionsRemoveItem = /شيل|احذف|ما طلبت|مو طلبت|remove|didn't order|never ordered/i.test(latestUserText);
      if (mentionsRemoveItem && existingOrder) {
        const mins = (Date.now() - new Date(existingOrder.createdAt).getTime()) / 60000;
        if (mins <= 5) {
          // Find which item to remove based on what the customer said
          const updatedItems = existingOrder.items.filter(item => {
            const itemNameLower = item.name.toLowerCase();
            return !latestUserText.toLowerCase().includes(itemNameLower.split(' ')[0].toLowerCase());
          });
          if (updatedItems.length < existingOrder.items.length) {
            const newTotal = updatedItems.reduce((sum, item) => sum + (item.price || 0) * (item.quantity || 1), 0);
            await Order.updateOne({ _id: existingOrder._id }, { $set: { items: updatedItems, total: newTotal } });
            const itemsSummary = updatedItems.map(i => `${i.name} x${i.quantity}`).join(", ");
            return { response: lang === "ar"
              ? `تمام، شلنا الصنف. الطلب هلق: ${itemsSummary || "فاضي"}. في شي ثاني؟`
              : `Done! Updated order: ${itemsSummary || "empty"}. Anything else?` };
          }
        }
      }

      // Check if customer is adding notes/customizations
      // Check if this is a note — either by keyword OR by GPT already extracting item notes
      const { orderExtracted: noteCheck } = await extractAndRespond(latestUserText, draft, orderDraft, transcript, agent, null, lang);
      const gptFoundNotes = noteCheck?.items?.some(i => i.notes) || noteCheck?.notes;
      const mentionsNotes = gptFoundNotes ||
        /بدون|بدو|without|no |extra|حار|spicy|سبايسي|اضافي|خضار|بصل|جبن|صوص|sauce|cheese|onion|vegg|notes|ملاحظة|عادي|حكيت|قلت|تكون|يكون/i.test(latestUserText);
      if (mentionsNotes && existingOrder) {
        const mins = (Date.now() - new Date(existingOrder.createdAt).getTime()) / 60000;
        if (mins <= 5) {
          // Use already-extracted notes from GPT (noteCheck from above), no extra API call
          const noteEx = noteCheck;
          const itemWithNote = noteEx?.items?.find(i => i.notes);
          let noteKeyword = itemWithNote?.notes || noteEx?.notes || null;
          // Fallback: strip filler words manually
          if (!noteKeyword) {
            noteKeyword = latestUserText
              .replace(/آه|اه|أه|لو سمحت|من فضلك|بعد إذنك|ممكن|بقدر|أبي|أريد|بدي|تمام|أكيد/gi, '')
              .replace(/الشاورما|الزنجر|البرجر|الدجاج|العصير|المندي|الكبسة/gi, '')
              .trim();
          }
          if (!noteKeyword || noteKeyword.length < 2) noteKeyword = latestUserText.trim();

          // Apply ALL extracted item notes
          let updatedItems = existingOrder.items.map(i => i.toObject ? i.toObject() : { ...i });

          if (noteEx?.items?.length > 0) {
            // GPT extracted specific item notes — apply each one
            const meaninglessNotes = /^(عادي|عادية|normal|regular|plain|عادي بس|nothing|لا شي|نفس|same)$/i;
            for (const extracted of noteEx.items) {
              if (!extracted.notes) continue;
              // Skip meaningless "notes" like "عادي" which means no customization
              if (meaninglessNotes.test(extracted.notes.trim())) continue;
              // Find matching item in existing order
              const matchIdx = updatedItems.findIndex(i =>
                i.name.toLowerCase().includes(extracted.name.toLowerCase().split(' ')[0]) ||
                extracted.name.toLowerCase().includes(i.name.toLowerCase().split(' ')[0])
              );
              if (matchIdx >= 0) {
                // If same item appears multiple times with different notes, split it
                const existing = updatedItems[matchIdx];
                if (existing.quantity > 1 && extracted.quantity < existing.quantity) {
                  updatedItems[matchIdx] = { ...existing, quantity: existing.quantity - extracted.quantity };
                  updatedItems.push({ ...existing, quantity: extracted.quantity, notes: extracted.notes });
                } else {
                  updatedItems[matchIdx] = { ...existing, notes: extracted.notes };
                }
              }
            }
          } else if (noteKeyword) {
            // Apply to first matching item or as order note
            const firstName = updatedItems[0]?.name?.toLowerCase().split(' ')[0];
            if (firstName && latestUserText.toLowerCase().includes(firstName)) {
              updatedItems[0] = { ...updatedItems[0], notes: noteKeyword };
            } else {
              await Order.updateOne({ _id: existingOrder._id }, { $set: { notes: noteKeyword } });
              return { response: lang === "ar" ? "تمام، أضفنا ملاحظتك. في شي ثاني؟" : "Got it! Added your note. Anything else?" };
            }
          }

          await Order.updateOne({ _id: existingOrder._id }, { $set: { items: updatedItems } });
          return { response: lang === "ar" ? "تمام، أضفنا ملاحظاتك. في شي ثاني؟" : "Got it! Added your notes. Anything else?" };
        }
      }

      // Customer wants to hear their order repeated back
      const wantsRepeat = /تعيد|كرر|عيدلي|قولي طلبي|شو طلبت|repeat|read.*order|order.*again|ممكن تعيد|اعد.*الطلب|الأوردر.*كامل/i.test(latestUserText);
      if (wantsRepeat && existingOrder) {
        const itemsList = existingOrder.items.map(item => {
          const notesStr = item.notes ? ` (${item.notes})` : '';
          if (lang === 'ar') {
            const qty = item.quantity > 1 ? ` ${item.quantity}` : '';
            return `${item.name}${qty}${notesStr}`;
          }
          return `${item.quantity > 1 ? item.quantity + 'x ' : ''}${item.name}${notesStr}`;
        }).join(lang === 'ar' ? ' و' : ', ');
        const addr = existingOrder.deliveryAddress || '';
        const name = existingOrder.customerName || draft.customerName || '';
        if (lang === 'ar') {
          return { response: `تفضل، طلبك: ${itemsList}. التوصيل على ${addr}، باسم ${name}. المجموع ${existingOrder.total} درهم. في شي بدك تغير؟` };
        }
        return { response: `Here's your order: ${itemsList}. Delivery to ${addr}, name ${name}. Total ${existingOrder.total} AED. Any changes?` };
      }

      // Customer wants to add more to their order
      const wantsToAdd = /بقدر أضيف|ممكن أضيف|أبي أضيف|بدي أضيف|can i add|i want to add|add another|أضيف كمان|بدي كمان|بدي أطلب كمان/i.test(latestUserText);
      if (wantsToAdd) {
        // Load the existing confirmed order to get its type and address
        const confirmedOrder = await Order.findOne({ callId, status: { $in: ["confirmed","preparing"] } }).sort({ createdAt: -1 }).lean();
        const preservedType    = confirmedOrder?.orderType    || orderDraft.orderType;
        const preservedAddress = confirmedOrder?.deliveryAddress || orderDraft.deliveryAddress;
        const preservedName    = confirmedOrder?.customerName  || draft.customerName;

        // Reset only items and status — preserve everything else from confirmed order
        orderDraft.items           = [];
        orderDraft.status          = null;
        orderDraft.orderType       = preservedType;
        orderDraft.deliveryAddress = preservedAddress;
        draft.customerName         = preservedName;

        await Call.updateOne({ _id: freshCall._id }, {
          $set: {
            "orderDraft.items":            [],
            "orderDraft.status":           null,
            "orderDraft.orderType":        preservedType,
            "orderDraft.deliveryAddress":  preservedAddress,
            "bookingDraft.customerName":   preservedName,
            "meta.addingToOrder":          true,
          }
        });
        return { response: lang === "ar" ? "أكيد! شو بدك تضيف؟" : "Sure! What would you like to add?" };
      }

      return { response: t("anythingElse", lang) };
    }
  }

  // FAST PATH: trivial responses skip GPT entirely
  // Greetings and small fillers when no order/booking active
  const trivialInput = latestUserText?.trim();
  // Fast-path ONLY for pure greetings — never when order content is detected
  const hasOrderContent = /زنجر|شاورما|عصير|ساندويش|بدي|أطلب|طلب|order|sandwich|juice/i.test(trivialInput || '');
  if (!bookingFlowActive && !orderFlowActive && !cancelIntent && !modifyIntent &&
      orderDraft.items.length === 0 && !draft.partySize && !hasOrderContent) {
    // Strip punctuation for matching
    const stripped = (trivialInput || '').replace(/[،,\.\!\?\s]+/g, ' ').trim();
    if (/^(الو|ألو|hello|hi|hey|مرحبا|أهلا|اهلا|هلا|هلو|السلام عليكم|وعليكم السلام)$/i.test(stripped)) {
      return { response: lang === "ar" ? "أهلين! شو بدك تطلب؟" : "Hi! What would you like to order?" };
    }
    if (/^(مرحبا يعطيك العافية|يعطيك العافية|الله يعافيك|هلا والله|أهلاً وسهلاً فيك|good day|good morning|good evening)$/i.test(stripped)) {
      return { response: lang === "ar" ? "الله يعافيك! شو بدك؟" : "Thank you! What can I get you?" };
    }
    if (/^(شكراً|شكرا|thanks|thank you|tnx|مشكور|تسلم)$/i.test(stripped)) {
      return { response: lang === "ar" ? "تسلم! شو بدك تطلب؟" : "Thanks! What would you like?" };
    }
    if (/^(مدري|i don't know|idk|not sure|ما بعرف|ما أدري)$/i.test(stripped)) {
      return { response: lang === "ar" ? "في عنا شاورما، زنجر، عصير وأكثر — شو بيشتهيك؟" : "We have shawarma, zinger, juice and more — what sounds good?" };
    }
  }

  // ── ACTIVE FLOW ───────────────────────────────────────────
  if (bookingFlowActive || orderFlowActive || cancelIntent || modifyIntent) {

    if (looksLikeGoodbye(latestUserText, transcript, orderDraft.status === "confirmed", !!justConfirmedBooking)) {
      return { response: buildGoodbye(latestUserText, lang), end_call: true };
    }

    // Fast-path: if customer says ONLY a delivery/pickup keyword and we have items,
    // set orderType immediately and ask next question — no GPT needed
    const isOnlyOrderType = /^(توصيل|delivery|دليفري|توصل)[s.!?،]*$/i.test(latestUserText.trim());
    const isOnlyPickup = /^(استلام|pickup|pick up|تيك اواي|آخذه)[s.!?،]*$/i.test(latestUserText.trim());
    if ((isOnlyOrderType || isOnlyPickup) && orderDraft.items?.length > 0 && !orderDraft.orderType) {
      const detectedType = isOnlyOrderType ? "delivery" : "pickup";
      orderDraft.orderType = detectedType;
      await Call.updateOne({ _id: freshCall._id }, { $set: { "orderDraft.orderType": detectedType } });
      if (detectedType === "delivery") {
        return { response: t("askDeliveryAddress", lang) };
      } else {
        return { response: t("askPickupTime", lang) };
      }
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
          ? { name: item, quantity: 1, extras: [], notes: null }
          : { name: item.name || item.item, quantity: item.quantity || 1, extras: item.extras || [], notes: item.notes ? translateToEnglishStorage(item.notes) : null }
      );
      const validItems = normalizedItems.filter(item =>
        item?.name && !!findMenuItem(agent.menu?.filter(m => m.available), item.name)
      );
      // GPT sees the FULL transcript — its extraction IS the ground truth.
      // Simply replace orderDraft.items with what GPT extracted (deduplicated by name+notes).
      // This avoids all accumulation bugs from sequential requests.
      
      if (validItems.length > 0) {
        // Deduplicate: collapse same name+notes into one entry, summing quantities
        const deduped = {};
        for (const item of validItems) {
          const key = (item.name + '|' + (item.notes || '')).toLowerCase();
          if (deduped[key]) {
            deduped[key].quantity += (item.quantity || 1);
          } else {
            deduped[key] = { ...item, quantity: item.quantity || 1 };
          }
        }
        orderDraft.items = Object.values(deduped);
      }
    }

    // Order type switch
    if (orderExtracted.orderType) {
      const newType  = orderExtracted.orderType;
      const prevType = orderDraft.orderType;
      if (newType !== prevType && prevType) {
        // Only switch if explicitly different AND no items yet (not mid-order)
        // Don't switch orderType mid-order just because GPT extracted a different one
        if (orderDraft.items?.length === 0) {
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
        }
        // If we already have items, keep the existing orderType
      } else {
        orderDraft.orderType = newType;
      }
    }
    // CRITICAL: if orderDraft already has an orderType from DB, never lose it
    // GPT returning orderType:null doesn't mean we should clear it
    // GPT sometimes returns the string "null" instead of JSON null — treat both as null
    const rawAddr = orderExtracted.deliveryAddress;
    const isNullAddr = !rawAddr || rawAddr === "null" || rawAddr === "undefined" || 
      rawAddr === "NULL" || rawAddr.trim() === "" || rawAddr.trim().length <= 3;
    if (!isNullAddr) {
      // Translate Arabic address words to English for storage
      orderDraft.deliveryAddress = translateToEnglishStorage(rawAddr);
    }
    // If address was saved but has no unit number, keep it but flag as incomplete
    // The fallback hint will ask for unit number
    if (orderExtracted.notes) orderDraft.notes = translateToEnglishStorage(orderExtracted.notes);

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
        "orderDraft.notes":            orderDraft.notes,
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

    // For delivery: if no time specified, default to "now" (immediate)
    if (orderDraft.orderType === "delivery" && !draft.requestedStart) {
      const dubaiNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Dubai" }));
      const dubaiOffset = 4 * 60;
      const utcNow = new Date();
      const utcMs = utcNow.getTime() + (utcNow.getTimezoneOffset() * 60000);
      draft.requestedStart = new Date(utcMs + (dubaiOffset * 60000));
      // Don't save to DB yet — will be saved at order creation
    }

    const deliveryComplete =
      orderDraft.orderType === "delivery" &&
      orderDraft.items?.length > 0 && orderDraft.deliveryAddress && draft.customerName;

    // Block GPT confirmation responses — only our save code should confirm
    const aiSoundsLikeConfirmation = aiResponse && (
      /تم (تأكيد|حجز|الحجز|الطلب)|confirmed|booking confirmed|order confirmed|your table is|طاولتك محجوزة/i.test(aiResponse)
    );

    if (aiResponse && !aiSoundsLikeConfirmation && !bookingComplete && !dineInComplete && !pickupComplete && !deliveryComplete) {
      return { response: aiResponse };
    }
    if (dineInComplete && !orderDraft.orderType) orderDraft.orderType = "dineIn";

    // ── DINE-IN ────────────────────────────────────────────
    if (dineInComplete) {
      if (processingCalls.has(callId)) return { response: t("oneMovement", lang) };
      processingCalls.add(callId);
      try {
        const total = orderDraft.items.reduce((sum, item) => {
          const mi = findMenuItem(agent.menu, item.name);
          return sum + (mi?.price || 0) * (item.quantity || 1);
        }, 0);
        const orderItems = orderDraft.items.map(item => {
          const mi = findMenuItem(agent.menu, item.name);
          return { name: item.name, quantity: item.quantity || 1, price: mi?.price || 0, extras: item.extras || [], notes: item.notes || null };
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
            notes: orderDraft.notes || null,
          });
          await Call.updateOne({ _id: freshCall._id }, {
            $set: {
              "bookingDraft.partySize": null, "bookingDraft.requestedStart": null, "bookingDraft.customerName": null,
              "orderDraft.items": [], "orderDraft.orderType": null, "orderDraft.deliveryAddress": null, "orderDraft.status": "confirmed",
            }
          });
          const timeString   = new Date(draft.requestedStart).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Dubai" });
          // Use Arabic item names in Arabic responses
      const itemsSummary = buildItemsSummary(orderDraft.items, agent.menu, lang);
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
    // Clear addingToOrder flag now that we have items
  if (isAddingToOrder && orderDraft.items?.length > 0) {
    await Call.updateOne({ _id: freshCall._id }, { $set: { "meta.addingToOrder": false } });
  }

  if (pickupComplete || deliveryComplete) {
      // Check for existing order in THIS call first (for add-to-order flow)
      // then fall back to returning caller's order
      const existingOrder =
        await Order.findOne({ callId, status: { $in: ["confirmed","preparing"] } }).sort({ createdAt: -1 }) ||
        (confirmedOrderId ? await Order.findById(confirmedOrderId) : null);
      const total = orderDraft.items.reduce((sum, item) => {
        const mi = findMenuItem(agent.menu, item.name);
        return sum + (mi?.price || 0) * (item.quantity || 1);
      }, 0);
      const orderItems = orderDraft.items.map(item => {
        const mi = findMenuItem(agent.menu, item.name);
        return { name: item.name, quantity: item.quantity || 1, price: mi?.price || 0, extras: item.extras || [], notes: item.notes || null };
      });

      if (existingOrder) {
        const existingItems = existingOrder.items.map(i => i.toObject ? i.toObject() : { ...i });

        // Each unique name+notes combination is a separate item.
        // Compare GPT's full extracted list against what's already confirmed.
        // Only add items that aren't already there (by exact name+notes match).
        
        for (const newItem of orderItems) {
          const exactKey = (newItem.name + '|' + (newItem.notes || '')).toLowerCase();
          const nameKey = newItem.name.toLowerCase();
          
          // Check if this exact variant (name+notes) already exists in confirmed order
          const exactMatch = existingItems.findIndex(e =>
            (e.name + '|' + (e.notes || '')).toLowerCase() === exactKey
          );
          
          if (exactMatch >= 0) {
            // Already exists — don't add again, just ensure qty is right
            // (don't increase qty here — customer didn't order more)
            continue;
          }
          
          // Check total qty of this name across all variants in confirmed order
          const confirmedQtyForName = existingItems
            .filter(e => e.name.toLowerCase() === nameKey)
            .reduce((s, e) => s + (e.quantity || 1), 0);
          
          // Check total qty of this name across all variants GPT extracted
          const extractedQtyForName = orderItems
            .filter(i => i.name.toLowerCase() === nameKey)
            .reduce((s, i) => s + (i.quantity || 1), 0);
          
          const toAdd = extractedQtyForName - confirmedQtyForName;
          
          if (toAdd > 0) {
            // This is a genuinely new item/variant — add it
            existingItems.push({
              name: newItem.name,
              quantity: Math.min(newItem.quantity || 1, toAdd),
              extras: [],
              notes: newItem.notes || null,
            });
          } else if (toAdd <= 0 && newItem.notes) {
            // Same total qty but this note variant doesn't exist — apply note to existing no-note entry
            const noNoteIdx = existingItems.findIndex(e =>
              e.name.toLowerCase() === nameKey && !e.notes
            );
            if (noNoteIdx >= 0) {
              existingItems[noNoteIdx].notes = newItem.notes;
            }
          }
        }

        const mergedTotal = existingItems.reduce((sum, item) => {
          const mi = findMenuItem(agent.menu, item.name);
          return sum + (mi?.price || 0) * (item.quantity || 1);
        }, 0);

        await Order.updateOne({ _id: existingOrder._id }, {
          $set: {
            items: existingItems,
            deliveryAddress: orderDraft.deliveryAddress || existingOrder.deliveryAddress,
            orderType: orderDraft.orderType,
            customerName: draft.customerName,
            total: mergedTotal, status: "confirmed",
            notes: orderDraft.notes || existingOrder.notes || null,
          }
        });
        Object.assign(orderDraft, { items: existingItems });
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
            notes: orderDraft.notes || null,
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

      const itemsSummary = buildItemsSummary(orderDraft.items, agent.menu, lang);
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
    // If address exists but has no unit number (no digits found), ask for it ONCE
    // But only if the customer didn't just mention a number in this turn
    if (orderDraft.orderType === "delivery" && orderDraft.items?.length > 0 && orderDraft.deliveryAddress) {
      const hasUnitNumber = /\d+/.test(orderDraft.deliveryAddress);
      const justSaidNumber = /\d+|zero|one|two|three|four|five|six|seven|eight|nine|hundred|مية|ميتين|متين|مئة/i.test(latestUserText);
      if (!hasUnitNumber && !justSaidNumber) {
        return { response: lang === "ar" ? "رقم الشقة أو الوحدة؟" : "What's the apartment or unit number?" };
      }
    }
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

    // If GPT asks about order type — check both the draft AND what was just extracted
    const currentOrderType = orderDraft.orderType || orderExtracted.orderType;
    let finalResponse = aiResponse;

    // If customer said delivery/pickup keywords in THIS message, never ask about it
    const justSaidDelivery = /توصل|توصيل|يوصل|delivery|دليفري/i.test(latestUserText);
    const justSaidPickup = /استلام|آخذه|pickup|تيك اواي/i.test(latestUserText);
    if (justSaidDelivery && !orderDraft.orderType) orderDraft.orderType = "delivery";
    if (justSaidPickup && !orderDraft.orderType) orderDraft.orderType = "pickup";

    const effectiveOrderType = orderDraft.orderType || orderExtracted.orderType;
    if (finalResponse && (effectiveOrderType || justSaidDelivery || justSaidPickup)) {
      const asksOrderType = /توصيل ولا استلام|delivery or pickup|pickup or delivery|شو بدك.*توصيل|توصيل.*استلام|شو نوع|كيف بدك.*order|استلام.*توصيل/i.test(finalResponse);
      // Also override if we already have address — no need to ask order type
      const alreadyHasAddress = !!(orderDraft.deliveryAddress && orderDraft.deliveryAddress !== "null");
      if (asksOrderType || (alreadyHasAddress && finalResponse && /توصيل|استلام|delivery|pickup/i.test(finalResponse) && !/وين|address|عنوان/.test(finalResponse))) {
        const ot = effectiveOrderType || (justSaidDelivery ? "delivery" : "pickup") || (alreadyHasAddress ? "delivery" : null);
        if (ot === "delivery" && !orderDraft.deliveryAddress)
          finalResponse = t("askDeliveryAddress", lang);
        else if (ot === "delivery" && orderDraft.deliveryAddress && !draft.customerName)
          finalResponse = t("askOrderName", lang);
        else if (ot === "pickup" && !draft.requestedStart)
          finalResponse = t("askPickupTime", lang);
        else if (!draft.customerName)
          finalResponse = t("askOrderName", lang);
        else
          finalResponse = lang === "ar" ? "في شي ثاني؟" : "Anything else?";
      }
    }

    return {
      response: finalResponse || t("howCanIHelp", lang),
      ...(finalResponse && (
        /goodbye|have a (wonderful|great|good) day/i.test(finalResponse) ||
        /مع السلامة|وداعاً|يوماً رائعاً/.test(finalResponse)
      ) ? { end_call: true } : {}),
    };
  }

  // ── GOODBYE ───────────────────────────────────────────────
  if (looksLikeGoodbye(latestUserText, transcript, orderDraft.status === "confirmed", !!justConfirmedBooking)) {
    return { response: buildGoodbye(latestUserText, lang), end_call: true };
  }

  // ── NOISE / FIRST TURN GUARD ──────────────────────────────
  // Retell fires response_required with noise before the customer speaks.
  // Detect meaningless first-turn noise and respond with a clean greeting.
  const isNoise =
    !latestUserText ||
    latestUserText.length < 3 ||
    /^\(inaudible/i.test(latestUserText) ||
    /^[\s\.,\-\!\?،]+$/.test(latestUserText.trim()) ||
    /^(hell|sor|h|uh|welcome)\b[\s\.\!]*$/i.test(latestUserText.trim());

  const transcriptLength = transcript?.length ?? 0;

  if (transcriptLength <= 1 && isNoise) {
    // Very first turn with noise — return clean greeting without hitting GPT
    const greeting = lang === "ar"
      ? `أهلاً وسهلاً في ${agent.businessName || "المطعم"}! شو بقدر أساعدك؟`
      : `Welcome to ${agent.businessName || "the restaurant"}! How can I help you?`;
    return { response: greeting };
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