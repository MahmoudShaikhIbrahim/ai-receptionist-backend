// src/ws/llmSocket.js

const { processLLMMessage } = require("../controllers/llmSocketController");

function handleLLMWebSocket(ws, req) {
  console.log("🔌 Retell WebSocket connected from:", req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown');

  // === CRITICAL: Send the FIRST message immediately after connect ===
  // Retell REQUIRES the server to send first
  // Use empty content → agent waits for user to speak first
  // Change content to a greeting if you want the agent to speak immediately
 

  // DO NOT send anything here
  // Wait for Retell to send interaction_type events
ws.send(JSON.stringify({
  response_id: 0,
  content: "Hello! Welcome to our restaurant. How can i help you today?",
  content_complete: true,
  end_call: false
}));

  ws.on("message", async (rawMessage) => {
    const messageStr = rawMessage.toString();
    console.log("📩 Received from Retell:", messageStr);

    try {
      const data = JSON.parse(messageStr);

      const interactionType = data.interaction_type;

      // Optional: handle ping/pong or pure updates that don't need response
      if (interactionType === "ping_pong" || interactionType === "update_only") {
        console.log("Ignoring non-response event:", interactionType);
        return;
      }

      // Only respond to events that require a reply
      if (!["response_required", "reminder_required"].includes(interactionType)) {
  
        console.log("Skipping event that doesn't require response:", interactionType);
        return;
      }

      // Extract the latest user utterance from the transcript array
      let latestUserText = "";
      if (Array.isArray(data.transcript)) {
        for (let i = data.transcript.length - 1; i >= 0; i--) {
          const utterance = data.transcript[i];
          if (utterance?.role === "user" && typeof utterance.content === "string") {
            latestUserText = utterance.content.trim();
            break;
          }
        }
      }

      console.log("Latest user text:", latestUserText || "(no user text yet)");

      // Get response text — use your controller or add logic here
      let responseText = await processLLMMessage({
        ...data,
        latest_user_text: latestUserText  // pass extracted text if your function expects it
      });

      // Fallback / minimal logic if processLLMMessage returns empty
      if (!responseText) {
        if (!latestUserText) {
          responseText = "Hello! How can I assist you with your reservation today?";
        } else {
          // Very basic placeholder — replace with real booking flow
          responseText = `I understood: "${latestUserText}". How many people would you like to book for?`;
        }
      }

      // Build correct Retell response format
      const payload = {
        response_id: data.response_id !== undefined ? data.response_id : 0,
        content: responseText,
        content_complete: true,
        end_call: false   // ← set to true only when you want to end the call
      };

      ws.send(JSON.stringify(payload));
      console.log("Sent response to Retell:", payload.content);

    } catch (err) {
      console.error("❌ Error processing message:", err.message);
      console.error("Raw message was:", messageStr);

      // Send graceful fallback — keep connection alive
      const fallback = {
        response_id: 0,
        content: "Sorry, I didn't catch that. Could you please repeat?",
        content_complete: true,
        end_call: false
      };
      ws.send(JSON.stringify(fallback));
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`🔌 Retell WebSocket closed (code: ${code})`, reason?.toString() || "no reason provided");
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message || err);
  });
}

module.exports = { handleLLMWebSocket };