// src/ws/llmSocket.js

const { processLLMMessage } = require("../controllers/llmSocketController");
const Agent = require("../models/Agent");
const Call  = require("../models/Call");

function extractLatestUserText(data) {
  const transcript = Array.isArray(data?.transcript)
    ? data.transcript
    : Array.isArray(data?.transcript_json)
    ? data.transcript_json
    : [];

  for (let i = transcript.length - 1; i >= 0; i--) {
    const item = transcript[i];
    if (!item || typeof item !== "object") continue;

    const text =
      typeof item.content === "string" ? item.content.trim()
      : typeof item.text === "string"  ? item.text.trim()
      : "";

    if (!text) continue;

    const role    = (item.role    || "").toLowerCase();
    const speaker = (item.speaker || "").toLowerCase();

    if (
      role === "user" || role === "caller" || role === "customer" ||
      speaker === "user" || speaker === "caller" || speaker === "customer"
    ) {
      return text;
    }

    if (i === transcript.length - 1 && role !== "agent" && role !== "assistant") {
      return text;
    }
  }
  return "";
}

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function handleLLMWebSocket(ws, req) {
  console.log("🔌 Retell WebSocket connected");
  const callStartTime = Date.now();

  // Track which response_ids we have fully completed (sent a real response for)
  const processedResponseIds = new Set();

  // Track which response_ids are currently being processed (in-flight)
  // Key: response_id, Value: true
  // NOTE: Retell reuses response_id per-call-turn, NOT globally.
  // We use callId+responseId as compound key to avoid cross-turn collisions.
  const inFlightKeys = new Set();

  let lastResponseText = null;
  let lastResponseId   = null;

  // Extract callId from WebSocket URL — e.g. /llm/respond/call_xxx
  const urlParts = (req?.url || "").split("/");
  const callIdFromUrl = urlParts[urlParts.length - 1]?.startsWith("call_")
    ? urlParts[urlParts.length - 1] : null;

  // Send initial greeting from agent settings
  (async () => {
    let agent = null;
    if (callIdFromUrl) {
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          const callDoc = await Call.findOne({
            $or: [{ callId: callIdFromUrl }, { call_id: callIdFromUrl }]
          }).lean();
          if (callDoc?.agentId) {
            agent = await Agent.findById(callDoc.agentId).lean();
            if (agent) break;
          }
        } catch (e) {
          console.error("Greeting attempt", attempt + 1, "error:", e.message);
        }
        await new Promise(r => setTimeout(r, 500));
      }
    }
    if (agent) {
      const isArabic = (agent.language || "English").toLowerCase().includes("arab");
      const greeting = isArabic
        ? `أهلاً وسهلاً في ${agent.businessName}! شو بقدر أساعدك؟`
        : `Welcome to ${agent.businessName}! How can I help you?`;
      safeSend(ws, { response_id: 0, content: greeting, content_complete: true, end_call: false });
      processedResponseIds.add("0");
      console.log(`📤 Greeting (${isArabic ? "ar" : "en"}): ${greeting}`);
    } else {
      safeSend(ws, { response_id: 0, content: "Welcome! How can I help you?", content_complete: true, end_call: false });
      processedResponseIds.add("0");
      console.log("📤 Greeting fallback — agent not found for", callIdFromUrl);
    }
  })();

  ws.on("message", async (rawMessage) => {
    let data;
    try {
      data = JSON.parse(rawMessage.toString());
    } catch {
      safeSend(ws, {
        response_id: 0,
        content: "Sorry, could you repeat that?",
        content_complete: true,
        end_call: false,
      });
      return;
    }

    try {
      const interactionType = data?.interaction_type;
      const responseId      = data?.response_id ?? 0;

      if (interactionType !== "response_required") return;

      // Use compound key: callId + responseId, because Retell reuses responseId
      // across turns (it's a per-turn counter, not globally unique per call)
      const latestUserText = extractLatestUserText(data);
      const flightKey = `${callIdFromUrl}:${responseId}:${latestUserText.slice(0, 30)}`;

      // Already fully processed this exact response — re-send if needed
      if (processedResponseIds.has(flightKey)) {
        console.log(`⏭ Already processed: ${flightKey}`);
        if (lastResponseText && lastResponseId === responseId) {
          safeSend(ws, {
            response_id: responseId,
            content: lastResponseText,
            content_complete: true,
            end_call: false,
          });
        }
        return;
      }

      // Currently processing this exact response — skip, don't queue or wait
      // The controller's promise-based lock will handle it
      if (inFlightKeys.has(flightKey)) {
        console.log(`⏳ Already in-flight, skipping: ${flightKey}`);
        return;
      }

      // Echo guard: the transcriber picks up the agent's own greeting audio
      // and sends it back as garbled text (e.g. "Welcome back to...").
      // For the first 5 seconds, only process turns that contain real Arabic
      // or are at least 4 words (real customer speech, not transcriber echo).
      const callAge = Date.now() - callStartTime;
      const textHasArabic = /[\u0600-\u06FF]/.test(latestUserText);
      const wordCount = latestUserText.trim().split(/\s+/).filter(Boolean).length;

      if (callAge < 5000 && !textHasArabic && wordCount < 4) {
        // This looks like a transcriber echo of our greeting — silently skip it.
        // Do NOT send any response back. Sending empty string causes TTS issues.
        console.log(`⏭ Echo guard skip (${callAge}ms): "${latestUserText}"`);
        return;
      }

      // Mark as in-flight
      inFlightKeys.add(flightKey);
      console.log("🗣 User:", latestUserText || "(none)");

      const result = await processLLMMessage(
        { ...data, latest_user_text: latestUserText },
        req
      );

      // Mark as done
      inFlightKeys.delete(flightKey);
      processedResponseIds.add(flightKey);

      // If controller returned null (locked/skipped), do nothing — no response sent
      if (!result || !result.response) return;

      const responseText  = result.response.trim();
      const shouldEndCall = result?.end_call === true;

      // Save last response for potential re-sends
      lastResponseText = responseText;
      lastResponseId   = responseId;

      console.log("📤 Response:", responseText);

      safeSend(ws, {
        response_id: responseId,
        content: responseText,
        content_complete: true,
        end_call: shouldEndCall,
      });

    } catch (err) {
      console.error("❌ Error:", err.message || err);
      const responseId = data?.response_id ?? 0;
      const latestUserText = extractLatestUserText(data);
      const flightKey = `${callIdFromUrl}:${responseId}:${latestUserText.slice(0, 30)}`;
      inFlightKeys.delete(flightKey);
      safeSend(ws, {
        response_id: responseId,
        content: "Sorry, something went wrong. Could you repeat that?",
        content_complete: true,
        end_call: false,
      });
    }
  });

  ws.on("close", (code) => console.log("🔌 WebSocket closed, code:", code));
  ws.on("error", (err)  => console.error("WebSocket error:", err.message));
}

module.exports = { handleLLMWebSocket };
