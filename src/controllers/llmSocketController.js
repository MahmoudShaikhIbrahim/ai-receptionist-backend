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

function extractPartySizeFromText(text) {
  if (!text) return null;

  const numericMatch = text.match(/\b(\d+)\b/);
  if (numericMatch) {
    const value = parseInt(numericMatch[1], 10);
    if (value > 0 && value <= 50) return value;
  }

  const wordMap = {
    one:1,two:2,three:3,four:4,five:5,
    six:6,seven:7,eight:8,nine:9,ten:10
  };

  for (const [word, number] of Object.entries(wordMap)) {
    const regex = new RegExp(`\\b${word}\\b`, "i");
    if (regex.test(text)) return number;
  }

  const phrases = [
    /table for (\d+)/i,
    /for (\d+) people/i,
    /party of (\d+)/i
  ];

  for (const pattern of phrases) {
    const match = text.match(pattern);
    if (match) {
      const value = parseInt(match[1], 10);
      if (value > 0 && value <= 50) return value;
    }
  }

  return null;
}

function extractTimeFromText(text) {
  if (!text) return null;

  const match = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!match) return null;

  let hour = parseInt(match[1],10);
  const minute = parseInt(match[2] || "0",10);
  const meridiem = match[3]?.toLowerCase();

  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;

  const requestedStart = new Date();
  requestedStart.setHours(hour,minute,0,0);

  return requestedStart;
}

function extractNameFromText(text) {
  if (!text) return null;

  const patterns = [
    /\bmy name is\s+([a-z][a-z\s'-]{1,49})/i,
    /\bi am\s+([a-z][a-z\s'-]{1,49})/i,
    /\bi'm\s+([a-z][a-z\s'-]{1,49})/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1]
        .split(" ")
        .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(" ");
    }
  }

  return null;
}

function extractBookingDataFromTranscript(transcript) {

  let partySize=null;
  let requestedStart=null;
  let customerName=null;

  const callerUtterances = transcript.filter(
    t => t && typeof t.content==="string" &&
    (t.role==="user" || t.role==="caller")
  );

  for(const utterance of callerUtterances){

    const normalized = normalizeText(utterance.content);

    if(!partySize) partySize = extractPartySizeFromText(normalized);
    if(!requestedStart) requestedStart = extractTimeFromText(normalized);
    if(!customerName) customerName = extractNameFromText(utterance.content);

  }

  return {
    partySize,
    requestedStart,
    customerName: customerName || "Phone Guest"
  };
}

function detectEndingIntent(text){

  if(!text) return false;

  return /\b(thanks?|thank you|goodbye|bye|that's all)\b/i.test(text);

}

async function processLLMMessage(body){

  console.log("WEBSOCKET LLM CONTROLLER HIT");

  const interactionType = body.interaction_type || body.type;

  if(interactionType==="ping_pong") return null;

  if(!["response_required","reminder_required"].includes(interactionType)){
    return null;
  }

  const transcript =
    Array.isArray(body.transcript) ? body.transcript :
    Array.isArray(body.transcript_json) ? body.transcript_json :
    [];

  const latestUser = transcript
    .filter(t => t.role==="user" || t.role==="caller")
    .pop();

  const latestUserText = latestUser?.content || "";

  if(detectEndingIntent(latestUserText)){
    return {
      response:"You're very welcome. We look forward to seeing you. Goodbye!",
      endCall:true
    };
  }

  const callId = body.call_id;

  if(!callId){
    console.warn("Missing call_id");
    return { response:"Sorry could you repeat that?" };
  }

  const existingBooking = await Booking.findOne({
    callId,
    status:{ $in:["confirmed","seated"] }
  }).lean();

  if(existingBooking){
    return { response:"Your reservation is already confirmed." };
  }

  const { partySize,requestedStart,customerName } =
    extractBookingDataFromTranscript(transcript);

  console.log("Extracted booking data:",{ partySize,requestedStart });

  if(partySize && requestedStart){

    console.log("📅 Booking intent detected");

    const call = await Call.findOne({
      $or:[{callId},{call_id:callId}]
    }).lean();

    if(!call){
      console.warn("Call not found:",callId);
      return { response:"Sorry could you repeat that?" };
    }

    const agent = await Agent.findById(call.agentId).lean();

    if(!agent){
      console.warn("Agent not found");
      return { response:"Sorry could you repeat that?" };
    }

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

    console.log("Booking engine result:",result);

    if(result?.success){
      return { response:"Perfect. Your table is confirmed." };
    }

    if(result?.suggestedTime){

      const t = new Date(result.suggestedTime)
        .toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",hour12:true});

      return { response:`We are full at that time. Would ${t} work instead?` };

    }

  }

  /* Only call AI if booking did not trigger */

  const messages = [{
    role:"system",
    content:`
You are a friendly restaurant receptionist.

Help customers book tables.
Ask only ONE question at a time.
Keep responses short.
`
  }];

  for(const item of transcript){

    if(!item || typeof item.content!=="string") continue;

    if(item.role==="user" || item.role==="caller")
      messages.push({role:"user",content:item.content});

    if(item.role==="assistant" || item.role==="agent")
      messages.push({role:"assistant",content:item.content});

  }

  const aiReply = await getAIResponse(messages);

  return { response: aiReply };

}

module.exports = { processLLMMessage };