const chrono = require("chrono-node");
const wordsToNumbers = require("words-to-numbers").wordsToNumbers;
const Business = require("../models/Business");
const Agent = require("../models/Agent");
const CallSession = require("../models/CallSession");
const { nowInTZ } = require("../utils/time");
const { createBooking } = require("../services/bookingService");
const { DateTime } = require("luxon");

/* --- helper functions unchanged --- */

function cleanText(s) {
  return (s || "").toString().trim();
}

function extractPartySize(text) {
  const t = cleanText(text).toLowerCase();
  const m = t.match(/\b(\d{1,2})\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 50) return n;
  }
  const w = wordsToNumbers(t, { fuzzy: true });
  if (typeof w === "number" && w >= 1 && w <= 50) return w;
  return null;
}

function extractName(text) {
  const t = cleanText(text);
  if (!t) return null;
  if (t.length <= 30) return t;
  return null;
}

function extractTimeInTZ(text, tz) {
  const base = nowInTZ(tz).toJSDate();
  const results = chrono.parse(text, base, { forwardDate: true });
  if (!results.length) return null;
  return results[0].start.date();
}

function formatTime12h(date, tz) {
  const d = DateTime.fromJSDate(date).setZone(tz);
  const h = d.hour % 12 === 0 ? 12 : d.hour % 12;
  const mm = d.minute.toString().padStart(2, "0");
  const ampm = d.hour >= 12 ? "pm" : "am";
  return `${h}:${mm} ${ampm}`;
}

function requireRetellSecret(req) {
  const got = req.headers["x-retell-secret"];
  const expected = process.env.RETELL_LLM_SECRET;
  if (!expected) return true;
  return got && got === expected;
}

/* ================= MAIN ================= */

exports.respond = async (req, res) => {
  try {
    if (!requireRetellSecret(req)) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const body = req.body || {};
    const callId = body.call_id || body.callId || null;
    const from = body.from || null;
    const businessId = body.business_id || body.businessId || null;
    const userText = body.transcript || body.user_text || "";

    if (!callId || !businessId) {
      return res.json({ response: "Sorry, something went wrong." });
    }

    const business = await Business.findById(businessId).lean();
    if (!business) {
      return res.json({ response: "Booking system unavailable." });
    }

    const tz = business.timezone || "Asia/Dubai";
    const agent = await Agent.findOne({ businessId }).lean();

    let session = await CallSession.findOne({ callId });
    if (!session) {
      session = await CallSession.create({
        callId,
        businessId,
        callerNumber: from || null,
        step: "ASK_GUESTS",
      });
    }

    const text = cleanText(userText);

    const maybeParty = extractPartySize(text);
    if (maybeParty && !session.partySize) session.partySize = maybeParty;

    const maybeTime = extractTimeInTZ(text, tz);
    if (maybeTime && !session.requestedStartIso) session.requestedStartIso = maybeTime;

    if (!session.name) {
      const maybeName = extractName(text);
      if (maybeName) session.name = maybeName;
    }

    if (!session.partySize) {
      session.step = "ASK_GUESTS";
      await session.save();
      return res.json({ response: "How many people?" });
    }

    if (!session.requestedStartIso) {
      session.step = "ASK_TIME";
      await session.save();
      return res.json({ response: "What time?" });
    }

    if (!session.name) {
      session.step = "ASK_NAME";
      await session.save();
      return res.json({ response: "Under what name?" });
    }

    if (session.step !== "CONFIRM") {
      session.step = "CONFIRM";
      await session.save();
      return res.json({
        response: `So ${session.partySize} people at ${formatTime12h(session.requestedStartIso, tz)} under ${session.name}?`,
      });
    }

    const yes = /\b(yes|yeah|confirm|ok)\b/i.test(text);
    const no = /\b(no|change|wrong)\b/i.test(text);

    if (!yes && !no) {
      return res.json({ response: "Yes or no?" });
    }

    if (no) {
      session.requestedStartIso = null;
      session.step = "ASK_TIME";
      await session.save();
      return res.json({ response: "Okay, what time instead?" });
    }

    // YES → BOOK USING SINGLE ENGINE
    const now = nowInTZ(tz);
    const reqDT = DateTime.fromJSDate(session.requestedStartIso).setZone(tz);

    const startIso = now.set({
      hour: reqDT.hour,
      minute: reqDT.minute,
      second: 0,
      millisecond: 0,
    }).toJSDate();

    const endIso = DateTime.fromJSDate(startIso)
      .plus({ minutes: business.defaultDiningDurationMinutes })
      .toJSDate();

    const booking = await createBooking({
      businessId,
      startIso,
      endIso,
      partySize: session.partySize,
      source: "ai",
      agentId: agent?._id || null,
      callId,
      customerName: session.name,
      customerPhone: session.callerNumber || null,
    });

    if (!booking) {
      session.requestedStartIso = null;
      session.step = "ASK_TIME";
      await session.save();
      return res.json({ response: "That time isn’t available. What other time?" });
    }

    session.step = "DONE";
    await session.save();

    return res.json({
      response: `Done. You're booked at ${formatTime12h(startIso, tz)} under ${session.name}.`,
    });

  } catch (err) {
    console.error("❌ LLM error:", err);
    return res.json({ response: "Sorry, something went wrong." });
  }
};