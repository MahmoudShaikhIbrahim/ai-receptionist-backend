const Agent = require("../models/Agent");
const Call = require("../models/Call");

exports.handleWebhook = async (req, res) => {
  try {
    const payload = req.body;

    // ✅ Retell payload structure (confirmed)
    const call = payload.call;

    if (!call || !call.agent_id || !call.call_id) {
      console.warn("Webhook ignored (missing ids)", {
        topLevelKeys: Object.keys(payload || {}),
        callKeys: call ? Object.keys(call) : null,
      });
      return res.status(200).json({ ignored: true });
    }

    const retellAgentId = call.agent_id;
    const callId = call.call_id;

    // 🔑 PRIMARY ROUTING
    const agent = await Agent.findOne({ retellAgentId });

    if (!agent) {
      console.warn("Unknown Retell agent:", retellAgentId);
      return res.status(200).json({ ignored: true });
    }

    // Idempotency
    const exists = await Call.findOne({ callId });
    if (exists) {
      return res.status(200).json({ duplicate: true });
    }

    // Normalize intent (Retell may send null)
    const intent = ["order", "booking", "inquiry"].includes(call.intent)
      ? call.intent
      : "unknown";

    await Call.create({
      businessId: agent.businessId,
      agentId: agent._id,
      retellAgentId,
      callId,

      callerNumber: call.from || null,
      calleeNumber: call.to || null,

      intent,

      orderData: call.order || null,
      bookingData: call.booking || null,

      summary: call.call_analysis?.call_summary || null,
      transcript: call.transcript || null,

      startedAt: call.started_at ? new Date(call.started_at) : null,
      endedAt: call.ended_at ? new Date(call.ended_at) : null,
      durationSeconds: call.duration_seconds || null,
    });

    console.log("✅ Call saved:", callId);
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("❌ Webhook processing error:", err);
    return res.status(500).json({ error: "Webhook failed" });
  }
};