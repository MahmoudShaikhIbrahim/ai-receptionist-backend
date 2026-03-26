// src/ws/llmSocket.js

const { processLLMMessage } = require("../controllers/llmSocketController");

/**
 * Extract the latest user text safely from Retell transcript
 */
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
      typeof item.content === "string"
        ? item.content.trim()
        : typeof item.text === "string"
        ? item.text.trim()
        : "";

    if (!text) continue;

    const role = (item.role || "").toLowerCase();
    const speaker = (item.speaker || "").toLowerCase();

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

  // ✅ Initial greeting sent immediately on connect
  safeSend(ws, {
    response_id: 0,
    content: "Hello! Welcome to our restaurant. How can I help you today?",
    content_complete: true,
    end_call: false,
  });
  // Mark response_id 0 as handled so Retell's initial response_required doesn't trigger a second greeting
  processedResponseIds.add(0);

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

      if (interactionType !== "response_required") {
        console.log("Skipping event:", interactionType);
        return;
      }

      if (processedResponseIds.has(responseId)) {
        console.log(`⏭ Skipping duplicate response_id: ${responseId}`);
        return;
      }

      processedResponseIds.add(responseId);

      const latestUserText = extractLatestUserText(data);
      console.log("🗣 Latest user text:", latestUserText || "(none)");

      /**
       * sendChunk — streams a partial response to Retell.
       * Retell TTS starts speaking immediately on the first chunk,
       * cutting perceived latency from ~3-4s to ~200-400ms.
       */
      const sendChunk = (text) => {
        if (!text) return;
        safeSend(ws, {
          response_id: responseId,
          content: text,
          content_complete: false,
          end_call: false,
        });
      };

      const result = await processLLMMessage(
        {
          ...data,
          latest_user_text: latestUserText,
        },
        req,
        sendChunk
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

      const shouldEndCall = result.end_call === true;

      if (result.streamed) {
        // Response content was already sent via sendChunk — just finalize
        safeSend(ws, {
          response_id: responseId,
          content: "",
          content_complete: true,
          end_call: shouldEndCall,
        });
      } else {
        // Non-streaming path — send the full response at once
        let responseText =
          typeof result.response === "string" ? result.response.trim() : "";

        if (!responseText) {
          responseText = latestUserText
            ? "Got it. Let me help you with that."
            : "I'm sorry, could you repeat that please?";
        }

        safeSend(ws, {
          response_id: responseId,
          content: responseText,
          content_complete: true,
          end_call: shouldEndCall,
        });
      }

      console.log(
        "📤 Response sent (streamed:",
        result.streamed ?? false,
        ") end_call:",
        shouldEndCall
      );
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
