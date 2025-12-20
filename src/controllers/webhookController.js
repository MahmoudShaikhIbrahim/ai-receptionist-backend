// src/controllers/webhookController.js
const Call = require("../models/Call");

exports.handleWebhook = async (req, res) => {
  try {
    const payload = req.body;

    // Retell sends many event types – only persist finalized calls
    if (payload.event !== "call_analyzed" || !payload.call) {
      return res.status(200).json({ ignored: true });
    }

    const call = payload.call;

    const callDoc = {
      call_id: call.call_id,
      provider: "retell",
      from: call.from || null,
      to: call.to || null,
      outcome: call.call_status || "unknown",
      transcript: call.transcript || "",
      timestamp: call.end_timestamp
        ? new Date(call.end_timestamp)
        : new Date(),

      // IMPORTANT: keep these nullable until real business mapping exists
      agentRef: null,
      businessRef: null,

      // Always store raw payload for audits & future features
      raw: payload,
    };

    await Call.create(callDoc);

    console.log("✅ Call saved:", call.call_id);

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("❌ Webhook failed:", err);
    return res.status(500).json({ error: "Webhook failed" });
  }
};