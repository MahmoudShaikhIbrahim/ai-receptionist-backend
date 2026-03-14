const { processLLMMessage } = require("../controllers/llmSocketController");

function handleLLMWebSocket(ws, req) {
  console.log(
    "🔌 Retell WebSocket connected from:",
    req.headers["x-forwarded-for"] ||
      req.socket.remoteAddress ||
      "unknown"
  );

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

      if (!["response_required", "reminder_required"].includes(interactionType)) {
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
        const utterance = transcript[i];

        if (
          (utterance?.role === "user" || utterance?.role === "caller") &&
          typeof utterance.content === "string"
        ) {
          latestUserText = utterance.content.trim();
          break;
        }
      }

      console.log("🗣 Latest user text:", latestUserText || "(none)");

      const result = await processLLMMessage(
  {
    ...data,
    latest_user_text: latestUserText,
  },
  req
);

      let responseText = result?.response;

      if (typeof responseText !== "string" || responseText.trim() === "") {
        responseText = "I'm sorry, could you repeat that please?";
      }

      const payload = {
  response_id: data.response_id ?? 0,
  content: responseText,
  content_complete: true,
  end_call: result?.end_call === true,
};

      ws.send(JSON.stringify(payload));
      console.log("📤 Sent response to Retell:", payload.content);
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