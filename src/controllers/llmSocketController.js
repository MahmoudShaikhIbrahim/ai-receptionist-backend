const Business = require("../models/Business");
const Agent = require("../models/Agent");
const CallSession = require("../models/CallSession");
const { nowInTZ } = require("../utils/time");
const { findNearestAvailableSlot } = require("../services/bookingService");
const { DateTime } = require("luxon");

// reuse your helpers from llmController
const {
  detectLang,
  extractPartySize,
  extractTimeInTZ,
  extractName,
  isYes,
  isNo,
  t,
  formatTime,
} = require("./llmHelpers"); // if separated

async function processLLMMessage(body) {
  const callId = body.call_id;
  const businessId = body.business_id;
  const from = body.from;

  if (!callId || !businessId) {
    return "Sorry, something went wrong.";
  }

  const business = await Business.findById(businessId).lean();
  if (!business) {
    return "Booking system unavailable.";
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

    return "How many people?";
  }

  const text =
    body.transcript ||
    body.user_text ||
    "";

  const lang = detectLang(text);

  const maybeParty = extractPartySize(text);
  if (maybeParty && !session.partySize) session.partySize = maybeParty;

  const maybeTime = extractTimeInTZ(text, tz);
  if (maybeTime && !session.requestedStartIso)
    session.requestedStartIso = maybeTime;

  if (!session.name) {
    const maybeName = extractName(text);
    if (maybeName) session.name = maybeName;
  }

  await session.save();

  // Continue your booking logic exactly as before
  // (same confirmation + findNearestAvailableSlot flow)

  return "Continue booking logic here";
}

module.exports = { processLLMMessage };