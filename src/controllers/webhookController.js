const Call = require("../models/Call");

exports.handleWebhook = async (req, res) => {
  try {
    console.log("🔥 Retell Webhook Event Received:");
    console.log(JSON.stringify(req.body, null, 2));

    const event = req.body;

    // Only handle events that contain call information
    if (!event || !event.call_id) {
      console.log("❌ No valid call data in webhook.");
      return res.status(200).json({ ignored: true });
    }

    // Normalize fields coming from Retell
    const callData = {
      call_id: event.call_id,
      agent_name: event.agent_name || "Unknown",
      call_type: event.call_type || "incoming",
      call_status: event.outcome || event.status || "unknown",
      createdAt: event.timestamp || new Date(),
    };

    // Save to MongoDB
    await Call.create(callData);

    console.log("✅ Call saved to database:", callData);

    // Reply fast so Retell doesn't resend
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("❌ ERROR handling webhook:", error);
    return res.status(500).json({ error: "Webhook processing failed" });
  }
};