// src/ws/llmSocket.js

const { processLLMMessage } = require("../controllers/llmSocketController");

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

  const processedResponseIds = new Set();

  // Send initial greeting and mark response_id 0 as handled
  // so Retell's first response_required doesn't cause a second greeting
  safeSend(ws, {
    response_id: 0,
    content: "Welcome to Al Bait Al Shami, How can I help you?",
    content_complete: true,
    end_call: false,
  });
  processedResponseIds.add(0);

  ws.on("message", async (rawMessage) => {
    let data;
    try {
      data = JSON.parse(rawMessage.toString());
    } catch {
      safeSend(ws, { response_id: 0, content: "Sorry, could you repeat that?", content_complete: true, end_call: false });
      return;
    }

    try {
      const interactionType = data?.interaction_type;
      const responseId      = data?.response_id ?? 0;

      if (interactionType !== "response_required") return;

      if (processedResponseIds.has(responseId)) {
        console.log("⏭ Skipping duplicate response_id:", responseId);
        return;
      }
      processedResponseIds.add(responseId);

      const latestUserText = extractLatestUserText(data);
      console.log("🗣 User:", latestUserText || "(none)");

      const result = await processLLMMessage(
        { ...data, latest_user_text: latestUserText },
        req
      );

      const responseText   = result?.response?.trim() || "I'm sorry, could you repeat that?";
      const shouldEndCall  = result?.end_call === true;

      console.log("📤 Response:", responseText);

      safeSend(ws, {
        response_id: responseId,
        content: responseText,
        content_complete: true,
        end_call: shouldEndCall,
      });

    } catch (err) {
      console.error("❌ Error:", err.message || err);
      safeSend(ws, {
        response_id: data?.response_id ?? 0,
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
