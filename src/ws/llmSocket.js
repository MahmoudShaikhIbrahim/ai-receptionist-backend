// src/ws/llmSocket.js

const { processLLMMessage } = require("../controllers/llmSocketController");

function handleLLMWebSocket(ws, req) {
  console.log(
    "🔌 Retell WebSocket connected from:",
    req.headers["x-forwarded-for"] ||
      req.socket.remoteAddress ||
      "unknown"
  );

  // Initial greeting
  ws.send(
    JSON.stringify({
      response_id: 0,
      content: "Hello! Welcome to our restaurant. How can I help you today?",
      content_complete: true,
      end_call: false,
    })
  );

  ws.on("message", async (rawMessage) => {
    const messageStr = rawMessage.toString();
    console.log("📩 Received from Retell:", messageStr);

    try {
      const data = JSON.parse(messageStr);
      const interactionType = data.interaction_type;

      // Only process real user turns
      if (interactionType !== "response_required") {
        console.log("Skipping event:", interactionType);
        return;
      }

      let latestUserText = "";

const transcript = Array.isArray(data.transcript)
  ? data.transcript
  : Array.isArray(data.transcript_json)
  ? data.transcript_json
  : [];

for (let i = transcript.length - 1; i >= 0; i--) {
  const item = transcript[i];

  if (
    (item?.role === "user" ||
     item?.role === "caller" ||
     item?.speaker === "user") &&
    typeof item.content === "string" &&
    item.content.trim().length > 0
  ) {
    latestUserText = item.content.trim();
    break;
  }
}

console.log("🗣 Latest user text:", latestUserText || "(none)");
      console.log("LATEST USER TEXT:", latestUserText);
      const result = await processLLMMessage(
        {
          ...data,
          latest_user_text: latestUserText,
        },
        req
      );

      // Defensive fallback
      if (!result) {
        console.warn("Controller returned null");
        return;
      }

      let responseText = result?.response;
      const shouldEndCall = result?.end_call === true;

      if (typeof responseText !== "string" || responseText.trim() === "") {
        responseText = "I'm sorry, could you repeat that please?";
      }

      const payload = {
        response_id: data.response_id ?? 0,
        content: responseText,
        content_complete: true,
        end_call: shouldEndCall,
      };

      ws.send(JSON.stringify(payload));

      console.log("📤 Sent response to Retell:", payload.content);
      console.log("☎️ End call:", shouldEndCall);

    } catch (err) {
      console.error("❌ Error processing message:", err.message || err);
      console.error("Raw message:", messageStr);

      ws.send(
        JSON.stringify({
          response_id: 0,
          content: "Sorry, something went wrong. Could you repeat that?",
          content_complete: true,
          end_call: false,
        })
      );
    }
  });

  ws.on("close", (code, reason) => {
    console.log(
      `🔌 Retell WebSocket closed (code: ${code})`,
      reason?.toString() || "no reason"
    );
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message || err);
  });
}

module.exports = { handleLLMWebSocket };