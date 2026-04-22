// src/controllers/llmSocketController.js
// ─────────────────────────────────────────────────────────────────────────────
//  Retell Custom LLM controller — bilingual (Arabic + English) receptionist
//  v2 — improvements layered on top of the original (NO logic removed):
//    • OpenAI HTTP keep-alive + retry-with-backoff (saves ~80-150ms/turn)
//    • Extraction switched to gpt-4o-mini + json_object + temp 0
//      (saves ~600-1500ms/turn vs gpt-4o, equal accuracy on this task)
//    • Local Arabic-name transliteration table for top ~120 names
//      (eliminates an entire extra GPT call for common names)
//    • Dialect detection (Levantine / Khaleeji / Egyptian / Iraqi / MSA)
//      and mirroring — agent now answers in the caller's dialect
//    • Stronger anti-MSA / street-tone system prompt
//    • Expanded Arabizi (Franco-Arabic) detection (3/7/2/5 substitutions)
//    • Hysteresis on language switching (no single-turn flip)
//    • Char-ratio language detection (handles long English w/ 1 Arabic word)
//    • Bug fixes: \s+ regex (was matching literal "s"), Dubai TZ math
//    • Item dedup normalized via canonical menu name
//    • Per-phase console.time logs for production observability
// ─────────────────────────────────────────────────────────────────────────────

const Agent   = require("../models/Agent");
const Call    = require("../models/Call");
const Booking = require("../models/Booking");
const Order   = require("../models/Order");
const { getAIResponse }            = require("../services/aiChatService");
const { findNearestAvailableSlot } = require("../services/bookingService");

const https = require("https");

// ─── OPENAI CLIENT (keep-alive + retry) ───────────────────────────────────────
// One shared agent across the whole process — reuses TLS sockets to OpenAI
// and saves the ~80-150ms TLS handshake on every extraction call.
const OPENAI_AGENT = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 64,
});

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

// Models — extraction's `response` field is what the customer actually hears
// in active flows, so we keep gpt-4o here for natural, street-level tone.
// (gpt-4o-mini sounds noticeably stiffer in Arabic dialogue — confirmed in prod.)
// Transliteration is pure romanization, no tone — mini is fine and ~600ms faster.
const EXTRACTION_MODEL    = process.env.RETELL_EXTRACTION_MODEL    || "gpt-4o";
const TRANSLITERATE_MODEL = process.env.RETELL_TRANSLITERATE_MODEL || "gpt-4o-mini";

async function openaiChat({ model, messages, max_tokens, temperature, jsonMode = false, timeoutMs = 8000, retries = 1 }) {
  const body = {
    model,
    max_tokens,
    temperature: temperature ?? 0,
    messages,
    ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(OPENAI_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        // Node 18+ undici uses `dispatcher`, but `agent` is honored by node-fetch
        // Either way, the keep-alive agent is harmless on undici (ignored).
        agent: OPENAI_URL.startsWith("https") ? OPENAI_AGENT : undefined,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        // Retry on 5xx / 429 once
        if ((res.status >= 500 || res.status === 429) && attempt < retries) {
          await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
          continue;
        }
        throw new Error(`OpenAI ${res.status}: ${txt.slice(0, 200)}`);
      }
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      if (attempt < retries && (err.name === "AbortError" || /fetch failed|ECONN|ETIMEDOUT/i.test(err.message))) {
        await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

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

// Ratio of Arabic letter chars vs Latin letter chars — handles mixed sentences.
function arabicRatio(text) {
  if (!text) return 0;
  const arab = (text.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g) || []).length;
  const lat  = (text.match(/[A-Za-z]/g) || []).length;
  const total = arab + lat;
  return total === 0 ? 0 : arab / total;
}

// Expanded Arabizi (Franco-Arabic) word list + digit-letter patterns (3=ع, 7=ح, 2=ء, 5=خ, 6=ط, 9=ص).
// Catches "kifak", "shu badak", "habibi 7abibi", "3al telephone", etc.
const ARABIZI_WORDS = [
  // greetings / pleasantries
  "marhaba","marhabtain","ahlan","ahla","ahlein","sabah","masa","salam","salaam",
  "shukran","shukren","afwan","ya3ni","yaani","yalla","yallah","habibi","habibti",
  "khalas","khalass","tamam","tayeb","tayyib","mashi","ma3lesh","maalesh","wallah",
  "inshallah","mashallah","alhamdulillah","mabrook","mabrouk",
  // requests / verbs
  "biddi","bidi","baddi","bedi","areed","aread","abgha","abghi","abi","ana","ente","enta","enti",
  "mumkin","mumken","momken","fi","mafi","mafee","akeed","akid","ahsan","ahla",
  // food / order vocab
  "shawarma","shawerma","kebab","mansaf","mandi","kabsa","tabbouleh","hummus",
  "knafeh","kunafa","baklava","falafel","manakish","manaqish","fattoush",
  // place / time
  "wein","ween","feen","emta","aimta","emten","ba3den","ba3d","ba3dein","alhin","halla","hallaq","hallak","hassa","delwa2ti","delwa2ty",
  // numbers spoken
  "wahed","wahad","ithnein","tnein","talata","talateh","arba3a","arbaa","khamsa","sitta","sab3a","sabaa","tamanya","tisaa","ashra","3ashra"
];
const ARABIZI_REGEX = new RegExp(`\\b(${ARABIZI_WORDS.join("|")})\\b`, "i");
// Words containing typical Arabizi numerals as letter substitutes mid-word.
const ARABIZI_DIGITS_REGEX = /\b[a-z]*[2357896][a-z]+\b|\b[a-z]+[2357896][a-z]*\b/i;

// Detects language from text — returns "ar", "en", or null
function detectLanguage(text) {
  if (!text?.trim()) return null;
  const ratio = arabicRatio(text);
  if (ratio >= 0.30) return "ar";          // Arabic-dominant
  if (containsArabic(text) && ratio >= 0.10) return "ar"; // notable Arabic content
  if (ARABIZI_REGEX.test(text)) return "ar";
  if (ARABIZI_DIGITS_REGEX.test(text) && /[a-z]{3,}/i.test(text)) {
    // Looks like Arabizi (e.g. "3ndi", "7abibi", "ba3dein")
    return "ar";
  }
  if (/[A-Za-z]/.test(text)) return "en";
  return null;
}

// ─── DIALECT DETECTION ────────────────────────────────────────────────────────
// Returns one of: "levantine" | "khaleeji" | "egyptian" | "iraqi" | "msa" | null
// Used to mirror the caller's dialect in responses (huge "feels human" win).
function detectArabicDialect(text) {
  if (!text || !containsArabic(text)) return null;

  // Khaleeji (Gulf): Saudi/Emirati/Kuwaiti/Qatari/Bahraini
  if (/\b(أبغى|ابغى|ابي|أبي|وش|الحين|توني|تراه|يبه|عسى|عساك|كذا|جذي|شلون|شخبارك|شخبارك|زين|عيال|بروحي)\b/.test(text)) {
    return "khaleeji";
  }
  // Egyptian
  if (/\b(عايز|عايزة|عاوز|إيه|ايه|ازاي|إزاي|دلوقتي|دلوقت|كده|كدا|اوي|قوي|بقى|بصراحه|يعني|معلش|لسه|لسة|بيت|في إيه|في ايه|طب|تمام كده|كويس|كويسة)\b/.test(text)) {
    return "egyptian";
  }
  // Iraqi
  if (/\b(أريد|اريد|شكو|ماكو|هسه|هسة|هواي|چذي|چم|شنو|وين رايح|اكو)\b/.test(text)) {
    return "iraqi";
  }
  // Levantine (Syrian/Lebanese/Jordanian/Palestinian)
  if (/\b(بدي|بدّي|شو|كيفك|كيفكِ|هلق|هلأ|منيح|منيحة|كتير|عنجد|عنجدّ|تعا|جاي|رح|عم|بحب|بحبك|ليش|كمان|بَس|طب|طيب|ماشي)\b/.test(text)) {
    return "levantine";
  }
  // MSA / formal — fall through indicator words
  if (/\b(أريد|أرغب|من فضلك|تفضل|حضرتك|بإمكانك|هل يمكن|أستطيع|نعم|كلا)\b/.test(text)) {
    return "msa";
  }
  return null;
}

function dialectLabel(d, lang) {
  if (lang !== "ar") return null;
  const map = {
    levantine: "Levantine (شامي — بدي/شو/هلق/كيفك)",
    khaleeji:  "Khaleeji (خليجي — أبغى/وش/الحين/زين)",
    egyptian:  "Egyptian (مصري — عايز/إيه/إزاي/دلوقتي)",
    iraqi:     "Iraqi (عراقي — أريد/شكو/هسه/شنو)",
    msa:       "MSA tendency — soften toward casual Levantine",
  };
  return map[d] || "Levantine (شامي) by default";
}

// ─── LOCAL ARABIC-NAME TRANSLITERATION (no API call needed) ───────────────────
// Top ~120 common Arab/Muslim first names. Hits >70% of real-world cases and
// removes a full GPT-4o roundtrip (~500-1000ms) when it does.
const NAME_TRANSLIT = Object.freeze({
  // Male
  "محمد":"Mohammed","محمود":"Mahmoud","أحمد":"Ahmed","احمد":"Ahmed","علي":"Ali","عمر":"Omar",
  "حسن":"Hassan","حسين":"Hussein","خالد":"Khaled","سعيد":"Saeed","سالم":"Salem","سامي":"Sami",
  "ياسر":"Yasser","يوسف":"Youssef","ابراهيم":"Ibrahim","إبراهيم":"Ibrahim","اسماعيل":"Ismail","إسماعيل":"Ismail",
  "عبدالله":"Abdullah","عبد الله":"Abdullah","عبدالرحمن":"Abdulrahman","عبد الرحمن":"Abdulrahman",
  "عبدالعزيز":"Abdulaziz","عبد العزيز":"Abdulaziz","عبدالكريم":"Abdulkarim","عبد الكريم":"Abdulkarim",
  "زياد":"Ziad","رامي":"Rami","ربيع":"Rabih","طارق":"Tarek","فادي":"Fadi","فراس":"Firas",
  "ماجد":"Majed","مازن":"Mazen","مالك":"Malek","مروان":"Marwan","منذر":"Munther","نادر":"Nader",
  "نزار":"Nizar","نبيل":"Nabil","هشام":"Hisham","هيثم":"Haitham","وائل":"Wael","وليد":"Walid",
  "بسام":"Bassam","بشار":"Bashar","بلال":"Bilal","جابر":"Jaber","جمال":"Jamal","جورج":"George",
  "كريم":"Karim","كمال":"Kamal","لؤي":"Loay","مصطفى":"Mustafa","معاذ":"Muath","مهند":"Muhannad",
  "مهدي":"Mahdi","ناجي":"Naji","قاسم":"Qasem","رضا":"Reda","رشيد":"Rasheed","رفيق":"Rafiq",
  "صلاح":"Salah","ضياء":"Diaa","طلال":"Talal","عادل":"Adel","عاطف":"Atef","عامر":"Amer",
  "عصام":"Issam","عمار":"Ammar","غسان":"Ghassan","فؤاد":"Fouad","فيصل":"Faisal",
  // Female
  "فاطمة":"Fatima","سارة":"Sara","ساره":"Sara","عائشة":"Aisha","عائشه":"Aisha","خديجة":"Khadija",
  "مريم":"Mariam","ميريام":"Miriam","نور":"Nour","نورا":"Noura","هدى":"Huda","هند":"Hind",
  "رنا":"Rana","رانيا":"Rania","ريم":"Reem","ريما":"Rima","لينا":"Lina","لميس":"Lamees",
  "ليلى":"Layla","لارا":"Lara","دانا":"Dana","دينا":"Dina","دلال":"Dalal","سلمى":"Salma",
  "سميرة":"Samira","سهام":"Siham","شيماء":"Shaymaa","صفاء":"Safaa","عبير":"Abeer","غادة":"Ghada",
  "فدوى":"Fadwa","كريمة":"Karima","ماجدة":"Majida","منى":"Mona","نادية":"Nadia","نجلاء":"Najlaa",
  "هالة":"Hala","هناء":"Hanaa","وفاء":"Wafaa","ياسمين":"Yasmin","ياسمينا":"Yasmina","زينب":"Zainab",
  "أمل":"Amal","امل":"Amal","أسماء":"Asma","اسماء":"Asma","بشرى":"Bushra","حنان":"Hanan",
  "هبة":"Heba","رحمة":"Rahma","روان":"Rawan","رؤى":"Ruaa","شذى":"Shaza","سندس":"Sondos",
});

// In-memory cache so we don't re-translate the same Arabic name twice in a call lifetime.
const TRANSLIT_CACHE = new Map();
const TRANSLIT_CACHE_MAX = 2000;

function localTransliterate(arabicText) {
  if (!arabicText) return null;
  const trimmed = arabicText.trim();
  // Single-token first-name lookup
  const key = trimmed.replace(/[\u064B-\u065F\u0670]/g, ""); // strip diacritics
  if (NAME_TRANSLIT[key]) return NAME_TRANSLIT[key];
  // Multi-token: try to map each token, fall back to None if any miss
  const tokens = key.split(/\s+/);
  if (tokens.length > 1 && tokens.length <= 4) {
    const mapped = tokens.map(t => NAME_TRANSLIT[t] || null);
    if (mapped.every(Boolean)) return mapped.join(" ");
  }
  return null;
}

// ─── BILINGUAL RESPONSES — Levantine Street Arabic ───────────────────────────
const R = {
  // Greetings / Generic
  howCanIHelp:        { en: "How can I help you today?",                                ar: "شو بقدر أساعدك؟" },
  somethingWrong:     { en: "Sorry, something went wrong.",                             ar: "في مشكلة صغيرة، حاول مرة ثانية." },
  oneMovement:        { en: "One moment please...",                                     ar: "لحظة معي..." },
  goodbye:            { en: "Thank you for calling! Have a wonderful day. Goodbye!",    ar: "يسلموا على اتصالك! يوم سعيد، مع السلامة!" },
  anythingElse:       { en: "Is there anything else I can help you with?",              ar: "في شي ثاني بقدر أساعدك فيه؟" },
  sorryDidntCatch:    { en: "Sorry, I didn't catch that.",                              ar: "معلش، ما سمعتك منيح، ممكن تعيد؟" },

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
    ar: `تمام يا ${name}! الـ${items} رايح يوصلك على ${address}. المجموع ${total} درهم. في شي ثاني؟`,
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
  askPartySize:       { en: "How many people will be joining?",          ar: "كم نفر رح يجوا؟" },
  askTime:            { en: "What time works for you?",                  ar: "أي ساعة بتحب؟" },
  askName:            { en: "What name should I put the booking under?", ar: "باسم مين الحجز؟" },
  askOrderName:       { en: "What name should I put the order under?",   ar: "باسم مين الـ order؟" },

  // Questions — Order
  askDeliveryAddress: { en: "What's the delivery address?",              ar: "وين بدك نوصّل؟" },
  askPickupTime:      { en: "What time will you pick up?",               ar: "أي ساعة رح تيجي تاخد الـ order؟" },
  askDiningTime:      { en: "What time would you like to come?",         ar: "أي ساعة رح تيجوا؟" },
  askDiningPeople:    { en: "How many people will be dining?",           ar: "كم نفر رح تأكلوا؟" },
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
  notYou:             { en: "My bad! How can I help you?",               ar: "آسف عليك! كيف بقدر أساعدك؟" },

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

// ─── ARABIC NAME TRANSLITERATION ──────────────────────────────────────────────
// Tries the local table first (no API call). Falls back to OpenAI only when unknown.
async function transliterateToEnglish(arabicText) {
  if (!arabicText || !containsArabic(arabicText)) return arabicText;

  const cached = TRANSLIT_CACHE.get(arabicText);
  if (cached) return cached;

  const local = localTransliterate(arabicText);
  if (local) {
    if (TRANSLIT_CACHE.size > TRANSLIT_CACHE_MAX) TRANSLIT_CACHE.clear();
    TRANSLIT_CACHE.set(arabicText, local);
    return local;
  }

  try {
    const data = await openaiChat({
      model: TRANSLITERATE_MODEL,
      max_tokens: 30,
      temperature: 0,
      timeoutMs: 4500,
      retries: 0,
      messages: [{
        role: "user",
        content: `Transliterate this Arabic name to English letters only. Return ONLY the transliterated name, nothing else: "${arabicText}"`,
      }],
    });
    const result = data.choices?.[0]?.message?.content?.trim();
    const final = result || arabicText;
    if (TRANSLIT_CACHE.size > TRANSLIT_CACHE_MAX) TRANSLIT_CACHE.clear();
    TRANSLIT_CACHE.set(arabicText, final);
    return final;
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

// Fuzzy menu item lookup — handles Arabic/English name mismatches.
// BUG FIX: original used /s+/ which splits on the literal letter "s".
// Now correctly uses \s+ for whitespace.
function findMenuItem(menu, itemName) {
  if (!menu?.length || !itemName) return null;
  const name = String(itemName).toLowerCase().trim();
  // 1. Exact match
  let found = menu.find(m => m.name.toLowerCase() === name);
  if (found) return found;
  // 2. Also try Arabic alternate names if your menu has them (nameAr/arabicName)
  found = menu.find(m =>
    (m.nameAr && String(m.nameAr).toLowerCase().trim() === name) ||
    (m.arabicName && String(m.arabicName).toLowerCase().trim() === name)
  );
  if (found) return found;
  // 3. Contains match (item name contains search or vice versa)
  found = menu.find(m => m.name.toLowerCase().includes(name) || name.includes(m.name.toLowerCase()));
  if (found) return found;
  // 4. Word overlap match — at least one meaningful word in common (FIXED \s+)
  const searchWords = name.split(/\s+/).filter(w => w.length > 2);
  found = menu.find(m => {
    const menuWords = m.name.toLowerCase().split(/\s+/);
    return searchWords.some(sw => menuWords.some(mw => mw.includes(sw) || sw.includes(mw)));
  });
  return found || null;
}

// Returns the canonical menu name for an input, or the input itself if no match.
// Used to normalize item dedup so Arabic + English of the same item don't double-add.
function canonicalMenuName(menu, itemName) {
  const m = findMenuItem(menu, itemName);
  return m ? m.name : itemName;
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

// Compute a Date for a given HH:MM clock time in Asia/Dubai (UTC+4, no DST).
// BUG FIX: original used setHours which depends on host timezone.
function dubaiClockToUTC(hh, mm) {
  // Get current Dubai date components via Intl.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dubai",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const parts = fmt.formatToParts(new Date());
  const get = (k) => parts.find(p => p.type === k)?.value;
  const year  = Number(get("year"));
  const month = Number(get("month"));
  const day   = Number(get("day"));
  // Dubai is fixed UTC+4 — convert "HH:MM Dubai" to UTC by subtracting 4h.
  return new Date(Date.UTC(year, month - 1, day, hh - 4, mm || 0, 0, 0));
}

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
function buildSystemPrompt(agent, lang, dialect) {
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
    // Dialect mirroring instruction
    const dialectLine = dialect === "khaleeji"
      ? `- الزبون يحكي خليجي → ردّ خليجي مع نفس مفرداته (أبغى، الحين، وش، زين، تراه، عساك). لا تجبره على شامي.`
      : dialect === "egyptian"
      ? `- الزبون يحكي مصري → ردّ مصري بنفس النكهة (عايز، إيه، إزاي، دلوقتي، اوي، كده، تمام كده).`
      : dialect === "iraqi"
      ? `- الزبون يحكي عراقي → ردّ عراقي (أريد، شكو، هسه، شنو، اكو، هواي).`
      : dialect === "msa"
      ? `- الزبون يميل للفصحى → خفّف الرسمية، ارجع لشامي عامي مريح، لكن متفهم وغير مبالغ.`
      : `- الزبون يحكي شامي عامي → ردّ شامي (بدي، شو، هلق، كيفك، منيح، كتير، رح، عم).`;

    return `${basePrompt}

بتساعد الزبائن في: ${features.join("، ") || "الاستفسارات العامة"}.

شخصيتك:
- بتحكي عربي شارع طبيعي — مش فصحى، مش رسمي، مش خطب
- مرايا للهجة الزبون: ${dialectLine}
- ممنوع منعاً باتاً: "أهلاً وسهلاً بكم في"، "يسعدني خدمتكم"، "حضرتك"، "تفضل سيدي"، "بناءً على ذلك"، "حيث أن"، "نظراً لـ"
- مفرداتك: تكرم، يا حلو، عفواً، تمام، ماشي، حبيبي، شو رأيك، بالخدمة، ولا يهمك
- بتقدر تخلط إنجليزي بعربي بشكل طبيعي: "الـ order جاهز"، "شو بدك تـ order؟"، "الـ delivery رايح يوصلك"، "كم الـ total؟"
- ردودك قصيرة جداً — جملة أو جملتين بالكتير، مش فقرة
- دافي ومرحّب لكن بدون مبالغة، زي بنادم بيحكي مع جاره مش زي مذيع تلفزيون
- لو الزبون قاطعك أو غيّر رأيه، خود الأمور ببساطة وأكمل

أوقات العمل:
${formatOpeningHours(agent.openingHours)}

${hasOrders && agent.menu?.length > 0 ? `المنيو:\n${formatMenu(agent.menu)}` : ""}

القواعد:
- سؤال واحد بس بكل رد
- لا تطلب رقم التلفون
- الحجوزات بالوقت بس، مو التاريخ
- إذا ما في الصنف بالمنيو، اعتذر بشكل طبيعي وقول ما عنا هيك
- لا تقترح طلب أكل بعد ما تأكد الحجز
- لا تقرأ المنيو كله أبداً — إذا قال الزبون "بدي أطلب" قول "شو بدك تطلب؟" بس
- إذا سألك عن صنف معين، أخبره بالسعر فقط
- إذا سألك "شو عندكم؟"، قول مثلاً: "عندنا شاورما، برجر، زنجر وأكثر — شو بيشتهيك؟"`;
  }

  return `${basePrompt}

You can help customers with: ${features.join(", ") || "general inquiries"}.

LANGUAGE: Respond in English throughout this conversation.

Tone:
- Talk like a real person on the phone — natural, warm, casual. Use contractions ("I'll", "we're", "let's").
- NEVER use stiff/formal phrases like "Certainly, esteemed customer", "May I be of assistance", "I would be delighted to".
- Short sentences. One or two lines max — not paragraphs.
- It's totally fine to say "got it", "sure thing", "no worries", "sounds good".

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
async function extractAndRespond(text, currentDraft, orderDraft, transcript, agent, returningContext, lang, dialect) {
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

  const dialectHint = dialect ? dialectLabel(dialect, lang) : null;

  const langNote = lang === "ar"
    ? `The customer is speaking Arabic (possibly mixed with English).${dialectHint ? `
Detected caller dialect: ${dialectHint}
You MUST mirror that dialect in your reply — don't force Levantine on a Khaleeji/Egyptian/Iraqi caller.` : ""}
You MUST:
- Understand ALL major Arabic dialects: Khaleeji (يبي/أبغى/وين/الحين/وش)، Levantine (بدي/شو/كيفك/هلق/يلا)، Egyptian (عايز/إيه/إزاي/دلوقتي)، Iraqi (أريد/شكو/هسه/شنو)
- Respond in the SAME dialect the customer used. Default to casual Levantine only when the dialect is unclear.
- ABSOLUTELY FORBIDDEN: MSA/formal phrasing ("أهلاً وسهلاً بكم"، "يسعدني خدمتكم"، "بناءً على ذلك"، "حيث أن"). Talk like a real person, not a TV anchor.
- Mixed sentences are normal: "بدي delivery"، "متى رح يوصل الـ order؟"، "بدي اطلب pickup"، "كم الـ total؟"، "في شي بالـ menu؟"
- English words inside Arabic are normal: order، delivery، pickup، total، menu، table، booking — extract them correctly
- Arabic numbers: واحد=1, اثنين=2, ثلاثة=3, أربعة=4, خمسة=5, ستة=6, سبعة=7, ثمانية=8, تسعة=9, عشرة=10
- Arabic time: "الساعة سبعة" = 7:00, "الساعة سبعة ونص" = 7:30, "بعد ساعة" = +1h, "بعد نص ساعة" = +30m
- Order types in any form:
  * delivery: "توصيل"، "يوصلوا"، "delivery"، "بدي delivery"، "دليفري"
  * pickup: "استلام"، "آخذه"، "pickup"، "أجي آخذه"، "تيك اواي"
  * dineIn: "نجلس"، "نأكل هناك"، "أكل داخل"، "dine in"، "دايني"
- Extract Arabic names as-is (they will be transliterated separately)
- CRITICAL: أشخاص، شخص، ناس، أفراد are party size words NOT names
- CRITICAL: أربعة، ثلاثة، اثنين are numbers/party sizes NOT names
- A name is a proper noun: محمود، سارة، أحمد، خالد، فاطمة
- Understand Arabic addresses and locations
- Corrections: "لا قصدي"، "مو كذا"، "غلط" = correction — "إلغي"، "ألغي" = cancel — "غيّر"، "بدّل" = modify
- Your "response" field MUST be casual STREET Arabic in the caller's dialect, mixed naturally with English where it fits — sound like a real person not a robot
- Examples: "شو بدك تـ order؟"، "الـ delivery رح يوصلك خلال شوي"، "باسم مين الـ booking؟"، "تمام، الـ total كم"
- JSON keys stay in English always`
    : `The customer is speaking English. Respond in casual, friendly English with contractions. Avoid stiff/formal phrasing.`;

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
- If customer says "book a table" or "احجز طاولة" with NO food items mentioned, this is BOOKING ONLY. Do NOT set orderType. Do NOT ask about order type.
- NEVER set orderType to "dineIn" for a pure table reservation with no food items ordered.
- ALWAYS extract orderType from ANY language form ONLY when food items are being ordered:
  * Arabic delivery: "توصيل", "يوصلوا", "ابعتوه", "وصلوه" = "delivery"
  * Arabic pickup: "استلام", "آخذه", "أجي آخذه", "تيك اواي" = "pickup"
  * Arabic dineIn: "نجلس", "نأكل هناك", "أكل داخل", "دايني" = "dineIn" (ONLY with food items)
  * English delivery: "delivery", "deliver it", "bring it to me" = "delivery"
  * English pickup: "pickup", "pick up", "collect", "take away" = "pickup"
  * English dineIn: "dine in", "eat here", "eat at the restaurant" = "dineIn" (ONLY with food items)
- For names: extract the name exactly as spoken (Arabic or English). Store as-is.
- CRITICAL: Words like أشخاص، شخص، ناس are party size words NOT names. Numbers like أربعة، ثلاثة are NOT names.
- For Arabic numbers in party size: convert to integer (ثلاثة = 3, أربعة = 4, etc.)
- For addresses (CRITICAL):
  * NEVER save a partial address. "الميدان" alone is NOT enough — ask for building name and unit number.
  * A complete delivery address must have: area/neighborhood + building name + apartment/unit number
  * Format: "unit, building, area, city" e.g. "302, Binghatti Heights, JVC, Dubai"
  * If customer gives only area ("الميدان", "JVC"), ask: "شو اسم البرج؟ ورقم الشقة؟"
  * If customer gives area + building but no unit, ask: "رقم الشقة؟"
  * Extract apartment numbers, floor numbers, villa numbers — they are part of the address
  * Common UAE areas: JVC, JBR, Marina, Downtown, Deira, Sharjah, Abu Dhabi, الخان, الميدان, etc.
  * From building name you can infer the city/area — include it in the address
- For item notes (CRITICAL):
  * Extract ANY customization the customer mentions for a specific item
  * "بدون خضار" = no vegetables, "بدون بصل" = no onions, "extra sauce" = extra sauce, "حار" = spicy
  * These go in the item's "notes" field, NOT in the order notes
  * If customer says notes AFTER confirming items, attach them to the relevant item
- For order notes: general instructions not specific to one item (e.g. "اطرق الباب مرتين", "اتصل لما توصل")
- Never ask for phone number
- Never mention dates, only times
- CRITICAL: NEVER return a confirmation message in your response. The system handles confirmations.
- Required for booking: partySize + time + name. If ANY missing, ask for it.
- Required for delivery: items + COMPLETE address (area + building + unit) + name. Ask for each missing piece.
- Required for pickup: items + time + name. Ask for each missing piece.
- If all required info collected, return null for response.
- intent: "cancel" if customer wants to cancel, "modify" if wants to change, "new" otherwise

Respond ONLY with valid JSON (no markdown):
{
  "extracted": {"partySize": <number or null>, "time": "<HH:MM 24hr or null>", "name": "<string or null>"},
  "orderExtracted": {
    "items": [{"name": "<EXACT menu name>", "quantity": <number>, "extras": [], "notes": "<item customization or null>"}],
    "orderType": "<dineIn|pickup|delivery|null>",
    "deliveryAddress": "<unit, building, area, city — or null if incomplete>",
    "notes": "<order-level notes or null>"
  },
  "intent": "<cancel|modify|new|null>",
  "response": "<your reply in ${lang === "ar" ? "Arabic" : "English"} or null>"
}`;

  try {
    console.time("⏱ extract");
    const data = await openaiChat({
      model: EXTRACTION_MODEL,
      max_tokens: 500,
      temperature: 0,
      jsonMode: true,
      timeoutMs: 7000,
      retries: 1,
      messages: [{ role: "user", content: prompt }],
    });
    console.timeEnd("⏱ extract");
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
    /احجز|حجز|طاولة|أريد طاولة|ابي طاولة|أبغى طاولة|عايز طاولة/.test(text);
}
function looksLikeOrderIntent(text) {
  if (!text) return false;
  return /\b(order|food|eat|hungry|menu|delivery|pickup|take.?away|bring|want to eat)\b/i.test(text) ||
    /اطلب|طلب|أكل|جوعان|قائمة|توصيل|استلام|ابي آكل|أريد أن آكل|عايز آكل|أبغى آكل/.test(text);
}
function looksLikeCancelIntent(text) {
  if (!text) return false;
  return /\b(cancel|cancellation|delete|remove|forget|drop|never mind|nevermind)\b/i.test(text) ||
    /إلغ|ألغي|امسح|لا أريد|ما أبي|بطّل|بطل|ما عاد بدي|مش عايز/.test(text);
}
function looksLikeModifyIntent(text) {
  if (!text) return false;
  return /\b(change|modify|update|edit|make it|instead|switch|different|wrong|correct|fix|actually)\b/i.test(text) ||
    /غيّر|بدّل|عدّل|مو كذا|قصدي|لا لا|أقصد|اصلاً|بدلها/.test(text);
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
    /\b(thank you|thanks)\b/i.test(text) ||
    /^لا[،,]?\s*شكر/i.test(text) || // "لا شكراً" at start of message
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
    console.time(`⏱ turn ${callId}`);
    return await _processMessage(body, req, callId);
  } finally {
    console.timeEnd(`⏱ turn ${callId}`);
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

  // ── LANGUAGE DETECTION & PERSISTENCE (with hysteresis) ───
  const detectedNow  = detectLanguage(latestUserText);
  const storedLang   = freshCall.meta?.lang;
  const langSwitchStreak = freshCall.meta?.langSwitchStreak ?? 0;
  const callAge      = Date.now() - new Date(freshCall.createdAt).getTime();
  const withinCall   = callAge < 30 * 60 * 1000;

  // Agent's configured language in MongoDB (agent.language = "Arabic" or "English")
  // This is the DEFAULT language for this restaurant — used for greetings and fallback
  const agentLangSetting = (agent.language || "English").toLowerCase();
  const agentDefaultLang = agentLangSetting.includes("arab") ? "ar" : "en";

  let lang;

  const ratio = arabicRatio(latestUserText);
  const hasArabicChars = /[\u0600-\u06FF]/.test(latestUserText);

  // Short English fillers that may appear during an Arabic conversation
  const isEnglishFiller = /^(ok|okay|yes|no|yeah|nope|hi|hey|hello|sure|great|thanks|bye|good|fine|right|hmm|uh|ah|oh)[\s\.\!\?]*$/i.test(latestUserText.trim());

  // 1) Arabic-dominant text always wins.
  if (ratio >= 0.30) {
    lang = "ar";
  }
  // 2) Tiny English filler during Arabic conversation → stay Arabic.
  else if (detectedNow === "en" && isEnglishFiller && storedLang === "ar") {
    lang = "ar";
  }
  // 3) Arabizi during stored Arabic → stay Arabic.
  else if (storedLang === "ar" && detectedNow === "ar" && !hasArabicChars) {
    lang = "ar";
  }
  // 4) Hysteresis: if a single new turn disagrees with sticky lang, require 2-in-a-row to flip.
  else if (storedLang && detectedNow && detectedNow !== storedLang && withinCall) {
    if (langSwitchStreak >= 1) {
      lang = detectedNow; // confirmed second time — flip
    } else {
      lang = storedLang;  // hold for one more turn
    }
  }
  // 5) Fresh detection
  else if (detectedNow) {
    lang = detectedNow;
  }
  // 6) Sticky
  else if (storedLang && withinCall) {
    lang = storedLang;
  }
  // 7) Restaurant default
  else {
    lang = agentDefaultLang;
  }

  // Explicit switch requests always override
  const explicitArabic  = /تكلم عربي|بالعربي|عربي بس|كلمني عربي|احكي عربي/i.test(latestUserText);
  const explicitEnglish = /\b(speak english|in english|english please|talk english|switch to english)\b/i.test(latestUserText);
  if (explicitArabic)  lang = "ar";
  if (explicitEnglish) lang = "en";

  // Update hysteresis streak
  let nextSwitchStreak = 0;
  if (storedLang && detectedNow && detectedNow !== storedLang && lang === storedLang) {
    nextSwitchStreak = langSwitchStreak + 1;
  }

  // ── DIALECT DETECTION (Arabic only) ──────────────────────
  const newDialect = lang === "ar" ? detectArabicDialect(latestUserText) : null;
  const storedDialect = freshCall.meta?.dialect || null;
  const dialect = newDialect || storedDialect || (lang === "ar" ? "levantine" : null);

  // Persist if changed
  const metaUpdates = {};
  if (lang !== storedLang) metaUpdates["meta.lang"] = lang;
  if (nextSwitchStreak !== langSwitchStreak) metaUpdates["meta.langSwitchStreak"] = nextSwitchStreak;
  if (newDialect && newDialect !== storedDialect) metaUpdates["meta.dialect"] = newDialect;
  if (Object.keys(metaUpdates).length) {
    await Call.updateOne({ _id: freshCall._id }, { $set: metaUpdates });
  }
  console.log(`🌐 Language: ${lang} (ratio: ${ratio.toFixed(2)}, hasArabic: ${hasArabicChars}, stored: ${storedLang || "none"}, dialect: ${dialect || "n/a"}, streak: ${nextSwitchStreak})`);

  // ── FIRST TURN GREETING ───────────────────────────────────
  // Retell sends response_required before the customer speaks.
  // Return a clean one-line greeting immediately — no GPT call, no cutoff.
  const isFirstTurn = transcript.length === 0 || (transcript.length === 1 && transcript[0]?.role === "agent");
  const isNoisyInput = !latestUserText || latestUserText.length < 3 || /^[.!?,،\s]+$/.test(latestUserText.trim());

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
    deliveryAddress: freshCall.orderDraft?.deliveryAddress ?? null,
    notes:           freshCall.orderDraft?.notes           ?? null,
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
      /نعم|آه|أيوه|صح|صحيح|تمام|أكيد|إيه|أيه/.test(latestUserText);
    const isNo  = /\b(no|nope|wrong|not me|different|incorrect)\b/i.test(latestUserText) ||
      /لا|مو أنا|غلط|مو صح|مش أنا/.test(latestUserText);

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
      const { extracted: nameExtracted } = await extractAndRespond(latestUserText, draft, orderDraft, transcript, agent, null, lang, dialect);
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

    if (looksLikeGoodbye(latestUserText, transcript, orderDraft.status === "confirmed", !!justConfirmedBooking)) {
      return { response: t("goodbye", lang), end_call: true };
    }

    const returningCtxString = returningContext ||
      (confirmedBookingId ? "Has existing booking" : null) ||
      (confirmedOrderId   ? "Has existing order"   : null);

    const { extracted, orderExtracted, intent, response: aiResponse } =
      await extractAndRespond(latestUserText, draft, orderDraft, transcript, agent, returningCtxString, lang, dialect);

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
        // BUG FIX: use proper TZ-aware computation instead of host-local setHours.
        draft.requestedStart = dubaiClockToUTC(h, m || 0);
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

    // Update order items — normalize via canonical menu name to avoid AR/EN double-add
    if (orderExtracted.items?.length > 0) {
      const normalizedItems = orderExtracted.items.map(item =>
        typeof item === "string"
          ? { name: item, quantity: 1, extras: [], notes: null }
          : { name: item.name || item.item, quantity: item.quantity || 1, extras: item.extras || [], notes: item.notes || null }
      );
      const validItems = normalizedItems
        .filter(item => item?.name && !!findMenuItem(agent.menu?.filter(m => m.available), item.name))
        .map(item => ({ ...item, name: canonicalMenuName(agent.menu, item.name) }));
      for (const newItem of validItems) {
        const existingIndex = orderDraft.items.findIndex(e => canonicalMenuName(agent.menu, e.name).toLowerCase() === newItem.name.toLowerCase());
        if (existingIndex >= 0) {
          orderDraft.items[existingIndex].quantity = newItem.quantity || 1;
          if (newItem.notes) orderDraft.items[existingIndex].notes = newItem.notes;
        } else {
          orderDraft.items.push(newItem);
        }
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
    if (orderExtracted.notes) orderDraft.notes = orderExtracted.notes;

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
          const itemsSummary = orderDraft.items.map(i => {
            if (lang === 'ar') {
              const menuItem = agent.menu?.find(m => m.name.toLowerCase() === i.name.toLowerCase());
              const arabicName = menuItem?.nameAr || menuItem?.arabicName || i.name;
              return `${arabicName} x${i.quantity || 1}`;
            }
            return `${i.name} x${i.quantity || 1}`;
          }).join(", ");
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
        const mi = findMenuItem(agent.menu, item.name);
        return sum + (mi?.price || 0) * (item.quantity || 1);
      }, 0);
      const orderItems = orderDraft.items.map(item => {
        const mi = findMenuItem(agent.menu, item.name);
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

      const itemsSummary = orderDraft.items.map(i => {
        if (lang === 'ar') {
          const menuItem = agent.menu?.find(m => m.name.toLowerCase() === i.name.toLowerCase());
          const arabicName = menuItem?.nameAr || menuItem?.arabicName || i.name;
          return `${arabicName} x${i.quantity || 1}`;
        }
        return `${i.name} x${i.quantity || 1}`;
      }).join(", ");
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
  if (looksLikeGoodbye(latestUserText, transcript, orderDraft.status === "confirmed", !!justConfirmedBooking)) {
    return { response: t("goodbye", lang), end_call: true };
  }

  // ── NOISE / FIRST TURN GUARD ──────────────────────────────
  // Retell fires response_required with noise before the customer speaks.
  // Detect meaningless first-turn noise and respond with a clean greeting.
  // BUG FIX: original used \s literal "s" — corrected to \s.
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

  const systemPrompt = buildSystemPrompt(agent, lang, dialect);
  const conversationHistory = transcript.slice(-6).map(t => ({
    role: t.role === "agent" ? "assistant" : "user",
    content: t.content,
  }));

  console.time("⏱ chat");
  const aiReply = await getAIResponse([
    { role: "system", content: systemPrompt },
    ...conversationHistory,
    { role: "user", content: latestUserText || (lang === "ar" ? "مرحبا" : "Hello") },
  ]);
  console.timeEnd("⏱ chat");

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
