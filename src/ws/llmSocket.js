const { processLLMMessage } = require("../controllers/llmSocketController");

function handleLLMWebSocket(ws, req) {
  console.log(
    "🔌 Retell WebSocket connected from:",
    req.headers["x-forwarded-for"] ||
      req.socket.remoteAddress ||
      "unknown"
  );

  ws.on("message", async (rawMessage) => {
    const messageStr = rawMessage.toString();
    console.log("📩 Received from Retell:", messageStr);

    try {
      const data = JSON.parse(messageStr);
      const interactionType = data.interaction_type;

      const transcript = Array.isArray(data.transcript)
        ? data.transcript
        : Array.isArray(data.transcript_json)
        ? data.transcript_json
        : [];

      if (interactionType === "response_required" && transcript.length === 0) {
        const greeting = {
          response_id: data.response_id,
          content:
            "Hello! Welcome to our restaurant. How can I help you today?",
          content_complete: true,
          end_call: false,
        };

        ws.send(JSON.stringify(greeting));
        console.log("📤 Sent greeting");
        return;
      }

      if (!["response_required", "reminder_required"].includes(interactionType)) {
        console.log("Skipping event:", interactionType);
        return;
      }

      let latestUserText = "";

      for (let i = transcript.length - 1; i >= 0; i--) {
        const utterance = transcript[i];

        if (
          (utterance?.role === "user" || utterance?.role === "caller") &&
          typeof utterance.content === "string"
        ) {
          latestUserText = utterance.content.trim();
          break;
        }
      }

      const result = await processLLMMessage({
        ...data,
        latest_user_text: latestUserText,
      });

      const payload = {
        response_id: data.response_id,
        content: result?.response || "Could you repeat that please?",
        content_complete: true,
        end_call: result?.endCall === true,
      };

      ws.send(JSON.stringify(payload));
      console.log("📤 Sent response:", payload.content);
    } catch (err) {
      console.error("❌ Error processing message:", err.message || err);

      ws.send(
        JSON.stringify({
          response_id: 0,
          content: "Sorry, something went wrong.",
          content_complete: true,
          end_call: false,
        })
      );
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`🔌 WebSocket closed (${code})`, reason?.toString());
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message || err);
  });
}

module.exports = { handleLLMWebSocket };