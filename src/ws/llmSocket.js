const { processLLMMessage } = require("../controllers/llmSocketController");  // keep if you want to reuse logic

function handleLLMWebSocket(ws, req) {
  console.log("🔌 Retell WebSocket connected");

  // CRITICAL: Send FIRST message immediately (empty = user speaks first)
  // Change content to a greeting if you want agent to start speaking
  const initialResponse = {
    response_id: 0,
    content: "",  // or "Welcome to our restaurant. How many people would you like to book for?"
    content_complete: true,
    end_call: false
  };
  ws.send(JSON.stringify(initialResponse));
  console.log("Sent initial response to Retell:", initialResponse);

  ws.on("message", async (rawMessage) => {
    const msgStr = rawMessage.toString();
    console.log("📩 Received from Retell:", msgStr);

    try {
      const data = JSON.parse(msgStr);

      // Log key fields
      console.log("Interaction type:", data.interaction_type);
      console.log("Transcript length:", data.transcript?.length || 0);

      if (data.interaction_type === "update_only") {
        // Just transcript update — no need to respond yet
        return;
      }

      if (data.interaction_type !== "response_required" && 
          data.interaction_type !== "reminder_required") {
        console.log("Ignoring non-response interaction:", data.interaction_type);
        return;
      }

      // Get latest user input from transcript array (latest user utterance)
      let latestUserText = "";
      if (Array.isArray(data.transcript)) {
        for (let i = data.transcript.length - 1; i >= 0; i--) {
          if (data.transcript[i].role === "user") {
            latestUserText = data.transcript[i].content.trim();
            break;
          }
        }
      }

      // Reuse or adapt your logic — for now simple placeholder
      // You can call your full booking logic here, track state via call_id / Map / DB
      let responseText = "";
      if (!latestUserText) {
        responseText = "Welcome! How can I help you today?";
      } else {
        // Integrate your extractPartySize, extractTimeInTZ, session logic, etc.
        // For quick test:
        responseText = "Got it: " + latestUserText + ". How many people?";
        // Later: call your processLLMMessage or main booking flow
      }

      const payload = {
        response_id: data.response_id !== undefined ? data.response_id : 1,
        content: responseText,
        content_complete: true,
        end_call: false  // set true only when done
      };

      ws.send(JSON.stringify(payload));
      console.log("Sent response:", payload.content);

    } catch (err) {
      console.error("❌ Parse/send error:", err.message, "Raw:", msgStr);
      ws.send(JSON.stringify({
        response_id: 0,
        content: "Sorry, something went wrong. Could you repeat?",
        content_complete: true,
        end_call: false
      }));
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`WS closed (code ${code}):`, reason?.toString() || "no reason");
  });

  ws.on("error", (err) => {
    console.error("WS error:", err);
  });
}

module.exports = { handleLLMWebSocket };