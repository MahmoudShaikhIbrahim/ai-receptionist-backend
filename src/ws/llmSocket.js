const { processLLMMessage } = require("../controllers/llmSocketController");

function handleLLMWebSocket(ws) {
  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message.toString());

      console.log("📩 WS Received:", data.interaction_type);

      const responseText = await processLLMMessage(data);

      const payload = {
        response: {
          text: responseText || "",
        },
      };

      ws.send(JSON.stringify(payload));
    } catch (err) {
      console.error("❌ WS Error:", err);
      ws.send(
        JSON.stringify({
          response: { text: "Sorry, something went wrong." },
        })
      );
    }
  });

  ws.on("close", () => {
    console.log("🔌 Retell WebSocket disconnected");
  });
}

module.exports = { handleLLMWebSocket };