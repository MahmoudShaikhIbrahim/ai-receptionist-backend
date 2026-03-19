// src/ws/llmSocket.js

const { processLLMMessage } = require("../controllers/llmSocketController");

/**
 * Extract the latest user text safely from Retell transcript
 * Handles missing roles / delayed tagging / last-item fallback
 */
function extractLatestUserText(data) {
  const transcript = Array.isArray(data?.transcript)
    ? data.transcript
    : Array.isArray(data?.transcript_json)
    ? data.transcript_json
    : [];

  // 🔥 Traverse from newest → oldest
  for (let i = transcript.length - 1; i >= 0; i--) {
    const item = transcript[i];
    if (!item || typeof item !== "object") continue;

    const text =
      typeof item.content === "string"
        ? item.content.trim()
        : typeof item.text === "string"
        ? item.text.trim()
        : "";

    if (!text) continue;

    const role = (item.role || "").toLowerCase();
    const speaker = (item.speaker || "").toLowerCase();

    // ✅ Strong user match
    if (
      role === "user" ||
      role === "caller" ||
      role === "customer" ||
      speaker === "user" ||
      speaker === "caller" ||
      speaker === "customer"
    ) {
      return text;
    }

    // 🔥 Fallback: last message (very important fix)
    if (
      i === transcript.length - 1 &&
      role !== "agent" &&
      role !== "assistant"
    ) {
      return text;
    }
  }

  return "";
}

/**
 * Safe WebSocket send
 */
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

  // ✅ Initial greeting (keep or remove depending on Retell config)
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

      // ❌ Ignore everything except response_required
      if (interactionType !== "response_required") {
        console.log("Skipping event:", interactionType);
        return;
      }

      // Prevent duplicate processing
      if (processedResponseIds.has(responseId)) {
        console.log(`⏭ Skipping duplicate response_id: ${responseId}`);
        return;
      }

      processedResponseIds.add(responseId);

      // 🔥 DEBUG (keep for now)
      console.log(
        "📜 FULL TRANSCRIPT:",
        JSON.stringify(data.transcript, null, 2)
      );

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