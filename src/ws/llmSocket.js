// src/controllers/llmSocketController.js

const Agent = require("../models/Agent");
const Call = require("../models/Call");
const Booking = require("../models/Booking");
const { wordsToNumbers } = require("words-to-numbers");

const { getAIResponse } = require("../services/aiChatService");
const { findNearestAvailableSlot } = require("../services/bookingService");

function normalizeText(value) {
  if (typeof value !== "string") return "";
  return wordsToNumbers(value.toLowerCase()).trim();
}

function isConversationEnding(text) {
  if (!text) return false;

  const normalized = text.toLowerCase();

  const phrases = [
    "bye",
    "goodbye",
    "thank you bye",
    "thanks bye",
    "that's all",
    "nothing else",
    "thank you"
  ];

  return phrases.some(p => normalized.includes(p));
}

function extractPartySizeFromText(text) {
  if (!text) return null;

  const match = text.match(/\b(\d+)\b/);

  if (match) {
    const value = parseInt(match[1], 10);
    if (value > 0 && value <= 50) return value;
  }

  const wordMap = {
    one:1,two:2,three:3,four:4,five:5,
    six:6,seven:7,eight:8,nine:9,ten:10
  };

  for (const [word,num] of Object.entries(wordMap)) {
    if (text.includes(word)) return num;
  }

  return null;
}

function extractTimeFromText(text) {
  if (!text) return null;

  const match = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);

  if (!match) return null;

  let hour = parseInt(match[1],10);
  const minute = parseInt(match[2] || "0",10);
  const meridiem = match[3];

  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;

  const date = new Date();
  date.setHours(hour,minute,0,0);

  return date;
}

function extractNameFromText(text) {

  const patterns = [
    /\bmy name is ([a-z\s]+)/i,
    /\bthis is ([a-z\s]+)/i,
    /\bi am ([a-z\s]+)/i,
    /\bi'm ([a-z\s]+)/i
  ];

  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]) return m[1].trim();
  }

  return null;
}

function extractBookingDataFromTranscript(transcript) {

  let partySize = null;
  let requestedStart = null;
  let customerName = null;

  const userLines = transcript.filter(
    t => (t.role === "user" || t.role === "caller") && typeof t.content === "string"
  );

  for (const line of userLines) {

    const normalized = normalizeText(line.content);

    if (!partySize)
      partySize = extractPartySizeFromText(normalized);

    if (!requestedStart)
      requestedStart = extractTimeFromText(normalized);

    if (!customerName)
      customerName = extractNameFromText(line.content);
  }

  return {
    partySize,
    requestedStart,
    customerName: customerName || "Phone Guest"
  };
}

function buildMessages(transcript) {

  const messages = [
    {
      role:"system",
      content:`
You are a friendly restaurant receptionist.

Collect:
- number of people
- time
- name

Ask only ONE question at a time.
Keep answers short.
`.trim()
    }
  ];

  for (const item of transcript) {

    if (!item?.content) continue;

    if (item.role === "user" || item.role === "caller") {
      messages.push({role:"user",content:item.content});
    }

    if (item.role === "assistant" || item.role === "agent") {
      messages.push({role:"assistant",content:item.content});
    }

  }

  return messages;
}

async function processLLMMessage(body) {

  console.log("LLM Controller processing");

  const transcript =
    Array.isArray(body.transcript) ? body.transcript :
    Array.isArray(body.transcript_json) ? body.transcript_json :
    [];

  const callId = body.call_id;

  const lastUserText = body.latest_user_text || "";

  if (isConversationEnding(lastUserText)) {

    return {
      response: "Thank you for calling. Have a great day!",
      endCall: true
    };

  }

  const { partySize, requestedStart, customerName } =
    extractBookingDataFromTranscript(transcript);

  console.log("Booking extraction",{
    partySize,
    requestedStart,
    customerName
  });

  try {

    if (partySize && requestedStart && callId) {

      const existingBooking = await Booking.findOne({
        callId,
        status:{ $in:["confirmed","seated"] }
      }).lean();

      if (existingBooking) {
        return {response:"Your reservation is already confirmed."};
      }

      const call = await Call.findOne({
        $or:[{callId},{call_id:callId}]
      }).lean();

      if (!call) {
        console.warn("Call not found");
      } else {

        const agent = await Agent.findById(call.agentId).lean();

        if (agent) {

          const result = await findNearestAvailableSlot({

            businessId:agent.businessId,
            requestedStart,
            durationMinutes:90,
            partySize,
            source:"ai",
            agentId:agent._id,
            callId,
            customerName,
            customerPhone:null,
            notes:null,
            searchWindowMinutes:120

          });

          console.log("Booking engine result",result);

          if (result?.success) {

            return {
              response:"Perfect. Your table is confirmed."
            };

          }

          if (result?.suggestedTime) {

            const t = new Date(result.suggestedTime);

            const label = t.toLocaleTimeString("en-US",{
              hour:"numeric",
              minute:"2-digit",
              hour12:true
            });

            return {
              response:`We are full at that time. Would ${label} work instead?`
            };

          }

        }

      }

    }

    const messages = buildMessages(transcript);

    const aiReply = await getAIResponse(messages);

    return {
      response: aiReply || "Could you repeat that please?"
    };

  } catch(err) {

    console.error("Controller error",err);

    return {
      response:"Sorry, could you repeat that please?"
    };

  }

}

module.exports = { processLLMMessage };