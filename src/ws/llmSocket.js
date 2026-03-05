// src/ws/llmSocket.js

const { processLLMMessage } = require("../controllers/llmSocketController");

function handleLLMWebSocket(ws, req) {
  console.log(
    "🔌 Retell WebSocket connected from:",
    req.headers["x-forwarded-for"] ||
      req.socket.remoteAddress ||
      "unknown"
  );

  // Send greeting immediately after connection
  ws.send(
    JSON.stringify({
      response_id: 0,
      content: "Hello! Welcome to our restaurant. How can I help you today?",
      content_complete: true,
      end_call: false
    })
  );

  ws.on("message", async (rawMessage) => {
    const messageStr = rawMessage.toString();
    console.log("📩 Received from Retell:", messageStr);

    try {
      const data = JSON.parse(messageStr);
      const interactionType = data.interaction_type;

      // Only respond when Retell expects a reply
      if (!["response_required", "reminder_required", "update"].includes(interactionType)) {
        console.log("Skipping event:", interactionType);
        return;
      }

      // Extract latest user speech from transcript
      let latestUserText = "";

      if (Array.isArray(data.transcript)) {
        for (let i = data.transcript.length - 1; i >= 0; i--) {
          const utterance = data.transcript[i];

          if (
            (utterance?.role === "user" || utterance?.role === "caller") &&
            typeof utterance.content === "string"
          ) {
            latestUserText = utterance.content.trim();
            break;
          }
        }
      }

      console.log("🗣 Latest user text:", latestUserText || "(none)");

      // Ask controller to generate AI reply
      let responseText = await processLLMMessage({
        ...data,
        latest_user_text: latestUserText
      });

      // Only fallback if controller returned nothing
      if (!responseText || responseText.trim() === "") {
        responseText = "I'm sorry, could you repeat that please?";
      }

      const payload = {
        response_id:
          data.response_id !== undefined ? data.response_id : 0,
        content: responseText,
        content_complete: true,
        end_call: false
      };
 
      ws.send(JSON.stringify(payload));
      console.log("📤 Sent response to Retell:", payload.content);
    } catch (err) {
      console.error("❌ Error processing message:", err.message);
      console.error("Raw message:", messageStr);

      ws.send(
        JSON.stringify({
          response_id: 0,
          content: "Sorry, something went wrong. Could you repeat that?",
          content_complete: true,
          end_call: false
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