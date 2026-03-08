// src/controllers/llmController.js
const llmResponses = new Map();
const chrono = require("chrono-node");
const wordsToNumbers = require("words-to-numbers").wordsToNumbers;
const Business = require("../models/Business");
const Agent = require("../models/Agent");
const CallSession = require("../models/CallSession");
const { nowInTZ } = require("../utils/time");
const { findNearestAvailableSlot } = require("../services/bookingService");
const { DateTime } = require("luxon");

/* ===============================
   Retell Response Helper
   Retell expects: { content, content_complete, end_call, response_id? }
=============================== */

function sendRetell(res, body, content) {
  const responseId = body?.response_id ?? body?.responseId ?? undefined;

  return res.json({
    ...(responseId !== undefined ? { response_id: responseId } : {}),
    content: String(content ?? ""),
    content_complete: true,
    end_call: false,
  });
}

/* ===============================
   Text + Language Helpers
=============================== */

function cleanText(s) {
  return (s || "").toString().trim();
}

function countMatches(str, re) {
  const m = str.match(re);
  return m ? m.length : 0;
}

function detectLang(text) {
  const t = cleanText(text);
  if (!t) return "en";

  const arabicChars = countMatches(
    t,
    /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g
  );
  const latinChars = countMatches(t, /[A-Za-z]/g);

  if (arabicChars === 0 && latinChars === 0) return "en";
  return arabicChars >= latinChars ? "ar" : "en";
}

function t(lang, key, vars = {}) {
  const en = {
    system_error: "Sorry, something went wrong.",
    booking_unavailable: "Booking system unavailable.",
    ask_guests: "How many people?",
    ask_time: "What time?",
    ask_name: "Under what name?",
    confirm_yes_no: "Yes or no?",
    confirm_template: "So {partySize} people at {time} under {name}?",
    change_time: "Okay, what time instead?",
    booked_template: "Done. You're booked at {time} under {name}.",
    not_available_suggest:
      "That time isn’t available. Would {time} work instead?",
    fully_booked:
      "We are fully booked around that time. What other time would you prefer?",
  };

  const ar = {
    system_error: "عذرًا، صار في مشكلة بسيطة.",
    booking_unavailable: "نظام الحجز غير متوفر حاليًا.",
    ask_guests: "كم عدد الأشخاص؟",
    ask_time: "على أي ساعة تحب الحجز؟",
    ask_name: "باسم مين يكون الحجز؟",
    confirm_yes_no: "نعم ولا لا؟",
    confirm_template: "تمام، {partySize} أشخاص الساعة {time} باسم {name}، صح؟",
    change_time: "تمام، أي وقت بدك بدلها؟",
    booked_template: "تم ✅ حجزك الساعة {time} باسم {name}.",
    not_available_suggest: "هالوقت غير متاح. هل يناسبك {time} بدلًا منه؟",
    fully_booked: "للأسف مزدحمين حول هالوقت. أي وقت ثاني تفضّل؟",
  };

  const dict = lang === "ar" ? ar : en;
  let msg = dict[key] || en[key] || key;

  for (const k of Object.keys(vars)) {
    msg = msg.replaceAll(`{${k}}`, String(vars[k]));
  }

  return msg;
}

/* ===============================
   Parsing Helpers
=============================== */

function normalizeArabicDigits(input) {
  const map = {
    "٠": "0",
    "١": "1",
    "٢": "2",
    "٣": "3",
    "٤": "4",
    "٥": "5",
    "٦": "6",
    "٧": "7",
    "٨": "8",
    "٩": "9",
    "۰": "0",
    "۱": "1",
    "۲": "2",
    "۳": "3",
    "۴": "4",
    "۵": "5",
    "۶": "6",
    "۷": "7",
    "۸": "8",
    "۹": "9",
  };

  return cleanText(input).replace(/[٠-٩۰-۹]/g, (d) => map[d] || d);
}

function extractPartySize(text) {
  const t0 = normalizeArabicDigits(text);
  const t = t0.toLowerCase();

  const m = t.match(/\b(\d{1,2})\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 50) return n;
  }

  const w = wordsToNumbers(t, { fuzzy: true });
  if (typeof w === "number" && w >= 1 && w <= 50) return w;

  const arMap = new Map([
    ["واحد", 1],
    ["واحدة", 1],
    ["اثنين", 2],
    ["اتنين", 2],
    ["اثنان", 2],
    ["ثلاثة", 3],
    ["تلاتة", 3],
    ["أربعة", 4],
    ["اربعة", 4],
    ["خمسة", 5],
    ["ستة", 6],
    ["سبعة", 7],
    ["ثمانية", 8],
    ["تمانية", 8],
    ["تسعة", 9],
    ["عشرة", 10],
    ["أحد عشر", 11],
    ["احدعشر", 11],
    ["حدعش", 11],
    ["اثنا عشر", 12],
    ["اثناعشر", 12],
    ["اتناعشر", 12],
    ["ثلاثة عشر", 13],
    ["تلتعشر", 13],
    ["أربعة عشر", 14],
    ["خمسة عشر", 15],
    ["ستة عشر", 16],
    ["سبعة عشر", 17],
    ["ثمانية عشر", 18],
    ["تسعة عشر", 19],
    ["عشرين", 20],
    ["عشرون", 20],
    ["ثلاثين", 30],
    ["أربعين", 40],
    ["اربعين", 40],
    ["خمسين", 50],
  ]);

  for (const [k, v] of arMap.entries()) {
    const re = new RegExp(`(^|\\s)${k}(\\s|$)`, "i");
    if (re.test(t0)) return v;
  }

  return null;
}

function extractName(text) {
  const t0 = cleanText(text);
  if (!t0) return null;

  const t = normalizeArabicDigits(t0);

  const ar1 = t.match(/(?:اسمي|أنا|انا)\s+([^\d]{2,30})/i);
  if (ar1 && ar1[1]) {
    const name = cleanText(ar1[1]).replace(/[?.!,]+$/g, "");
    if (name && name.length <= 30) return name;
  }

  const en1 = t.match(
    /(?:my name is|i am|it's)\s+([a-zA-Z][a-zA-Z\s'.-]{1,29})/i
  );
  if (en1 && en1[1]) {
    const name = cleanText(en1[1]).replace(/[?.!,]+$/g, "");
    if (name && name.length <= 30) return name;
  }

  if (t.length <= 30 && !/\b(yes|no|confirm|ok|okay)\b/i.test(t)) return t;
  return null;
}

function extractTimeInTZ(text, tz) {
  const base = nowInTZ(tz).toJSDate();
  const normalized = normalizeArabicDigits(text);

  const results = chrono.parse(normalized, base, { forwardDate: true });
  if (results.length) return results[0].start.date();

  const m = normalized.match(
    /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|ص|م)\b/i
  );
  if (!m) return null;

  let hh = parseInt(m[1], 10);
  const mm = m[2] ? parseInt(m[2], 10) : 0;
  const mer = (m[3] || "").toLowerCase();

  if (!Number.isFinite(hh) || hh < 0 || hh > 23) return null;
  if (!Number.isFinite(mm) || mm < 0 || mm > 59) return null;

  const isPM = mer === "pm" || mer === "p.m." || mer === "م";
  const isAM = mer === "am" || mer === "a.m." || mer === "ص";

  if (isAM || isPM) {
    hh = hh % 12;
    if (isPM) hh += 12;
  }

  const nowDT = DateTime.fromJSDate(base).setZone(tz);
  let dt = nowDT.set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
  if (dt <= nowDT) dt = dt.plus({ days: 1 });

  return dt.toJSDate();
}

function formatTime(date, tz, lang = "en") {
  const d = DateTime.fromJSDate(date).setZone(tz);
  const h12 = d.hour % 12 === 0 ? 12 : d.hour % 12;
  const mm = d.minute.toString().padStart(2, "0");

  if (lang === "ar") {
    const marker = d.hour >= 12 ? "م" : "ص";
    return `${h12}:${mm} ${marker}`;
  }

  const ampm = d.hour >= 12 ? "pm" : "am";
  return `${h12}:${mm} ${ampm}`;
}

function isYes(text, lang) {
  const t = normalizeArabicDigits(text).toLowerCase();
  if (lang === "ar") {
    return /(^|\s)(نعم|اي|أيوه|ايوه|تمام|اوكي|أوكي|موافق|تأكيد|أكد|أكيد)(\s|$)/i.test(
      t
    );
  }
  return /\b(yes|yeah|yep|confirm|ok|okay|sure)\b/i.test(t);
}

function isNo(text, lang) {
  const t = normalizeArabicDigits(text).toLowerCase();
  if (lang === "ar") {
    return /(^|\s)(لا|لأ|لاا|مش|مو|موش|غير|تغيير|غلط|مش صح)(\s|$)/i.test(t);
  }
  return /\b(no|change|wrong|not)\b/i.test(t);
}

/* ===============================
   Retell Request Parsing
=============================== */

function getLatestUserText(body) {
  // Retell docs: transcript is an array of utterances { role, content }  [oai_citation:3‡docs.retellai.com](https://docs.retellai.com/integrate-llm/integrate-llm)
  const tx = body?.transcript;

  if (Array.isArray(tx)) {
    for (let i = tx.length - 1; i >= 0; i--) {
      const u = tx[i];
      if (u && u.role === "user" && typeof u.content === "string") {
        return u.content;
      }
    }
  }

  // Backward compatibility with your earlier payloads
  if (typeof body?.user_text === "string") return body.user_text;
  if (typeof body?.text === "string") return body.text;
  if (typeof body?.transcript === "string") return body.transcript;

  return "";
}

/* ================= MAIN ================= */

exports.respond = async (req, res) => {
  console.log("HTTP LLM CONTROLLER HIT");
  console.log("LLM CONTROLLER HIT");

  try {
    const body = req.body || {};

    const interactionType = body.interaction_type || body.interactionType;
    const responseRequired =
      !interactionType ||
      interactionType === "response_required" ||
      interactionType === "reminder_required";

    const callId = body.call_id || body.callId || null;
    const from = body.from || null;
    const businessId = body.business_id || body.businessId || null;

    if (!responseRequired) {
      return res.status(200).json({ ignored: true });
    }

    if (!callId || !businessId) {
      return res.status(200).json({
        response: { text: "Sorry, something went wrong." },
      });
    }

    const business = await Business.findById(businessId).lean();
    if (!business) {
      return res.status(200).json({
        response: { text: "Booking system unavailable." },
      });
    }

    let session = await CallSession.findOne({ callId });
    if (!session) {
      session = await CallSession.create({
        callId,
        businessId,
        callerNumber: from || null,
        step: "ASK_GUESTS",
      });
    }

    const userText = getLatestUserText(body);
    const text = cleanText(userText);

    // FIRST GREETING
    if (!text || text.trim().length === 0) {
      session.lastAssistantText =
        "Hello, thank you for calling. How can I help you today?";
      await session.save();

      return res.status(200).json({
        response: { text: session.lastAssistantText },
      });
    }

    const lang = detectLang(text);

    if (!session.partySize) {
      session.lastAssistantText = t(lang, "ask_guests");
      await session.save();
      return res.status(200).json({
        response: { text: session.lastAssistantText },
      });
    }

    // Add the rest of your booking logic here exactly as before
    // Every time you produce a message:
    // session.lastAssistantText = message;
    // await session.save();
    // return res.status(200).json({ response: { text: message } });

    session.lastAssistantText = "Booking logic placeholder.";
    await session.save();

    return res.status(200).json({
      response: { text: session.lastAssistantText },
    });

  } catch (err) {
    console.error("LLM error:", err);
    return res.status(200).json({
      response: { text: "Sorry, something went wrong." },
    });
  }
};