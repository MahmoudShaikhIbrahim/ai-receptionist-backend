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

    const role = typeof item.role === "string" ? item.role.toLowerCase() : "";
    const speaker =
      typeof item.speaker === "string" ? item.speaker.toLowerCase() : "";

    const text =
      typeof item.content === "string"
        ? item.content.trim()
        : typeof item.text === "string"
        ? item.text.trim()
        : "";

    const isUser =
      role === "user" ||
      role === "caller" ||
      role === "customer" ||
      speaker === "user" ||
      speaker === "caller" ||
      speaker === "customer";

    if (isUser && text.length > 0) {
      return text;
    }
  }

  return "";
}

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== ws.OPEN) {
    console.warn("⚠️ WebSocket is not open. Skipping send.");
    return;
  }

  ws.send(JSON.stringify(payload));
}

function handleLLMWebSocket(ws, req) {
  console.log(
    "🔌 Retell WebSocket connected from:",
    req.headers["x-forwarded-for"] ||
      req.socket.remoteAddress ||
      "unknown"
  );

  const processedResponseIds = new Set();

  // Optional greeting.
  // Keep this only if Retell is NOT already sending an opening message itself.
  safeSend(ws, {
    response_id: 0,
    content: "Hello! Welcome to our restaurant. How can I help you today?",
    content_complete: true,
    end_call: false,
  });

  ws.on("message", async (rawMessage) => {
    const messageStr = rawMessage.toString();
    console.log("📩 Received from Retell:", messageStr);

    let data;

    try {
      data = JSON.parse(messageStr);
    } catch (parseErr) {
      console.error("❌ Failed to parse Retell message:", parseErr.message);
      console.error("Raw message:", messageStr);

      safeSend(ws, {
        response_id: 0,
        content: "Sorry, I had trouble understanding that. Could you repeat it?",
        content_complete: true,
        end_call: false,
      });
      return;
    }

    try {
      const interactionType = data?.interaction_type;
      const responseId = data?.response_id ?? 0;

      // Prevent duplicate processing of the same response turn
      if (processedResponseIds.has(responseId)) {
        console.log(`⏭ Skipping duplicate response_id: ${responseId}`);
        return;
      }

      // Only process turns where Retell expects a response
      if (
        interactionType !== "response_required" &&
        interactionType !== "reminder_required"
      ) {
        console.log("Skipping event:", interactionType);
        return;
      }

      processedResponseIds.add(responseId);

      const latestUserText = extractLatestUserText(data);

      console.log("🗣 Latest user text:", latestUserText || "(none)");

      const result = await processLLMMessage(
        {
          ...data,
          latest_user_text: latestUserText,
        },
        req
      );

      if (!result || typeof result !== "object") {
        console.warn("⚠️ Controller returned invalid result:", result);

        safeSend(ws, {
          response_id: responseId,
          content: "Sorry, could you say that again?",
          content_complete: true,
          end_call: false,
        });
        return;
      }

      let responseText =
        typeof result.response === "string" ? result.response.trim() : "";

      const shouldEndCall = result.end_call === true;

      if (!responseText) {
        responseText = latestUserText
          ? "Got it. Let me help you with that."
          : "I'm sorry, could you repeat that please?";
      }

      const payload = {
        response_id: responseId,
        content: responseText,
        content_complete: true,
        end_call: shouldEndCall,
      };

      safeSend(ws, payload);

      console.log("📤 Sent response to Retell:", payload.content);
      console.log("☎️ End call:", shouldEndCall);
    } catch (err) {
      console.error("❌ Error processing message:", err.message || err);
      console.error("Raw message:", messageStr);

      safeSend(ws, {
        response_id: data?.response_id ?? 0,
        content: "Sorry, something went wrong. Could you repeat that?",
        content_complete: true,
        end_call: false,
      });
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