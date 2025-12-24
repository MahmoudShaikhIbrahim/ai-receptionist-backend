const Agent = require("../models/Agent");
const Call = require("../models/Call");

exports.handleWebhook = async (req, res) => {
  try {
    const event = req.body;

    // 🔴 Correct Retell fields
    const retellAgentId = event?.agent?.id;
    const callId = event?.call?.id;

    if (!retellAgentId || !callId) {
      console.warn("Webhook ignored (missing agent.id or call.id)");
      return res.status(200).json({ ignored: true });
    }

    // 🔑 PRIMARY ROUTING KEY
    const agent = await Agent.findOne({ retellAgentId });

    if (!agent) {
      console.warn("Unknown Retell agent:", retellAgentId);
      return res.status(200).json({ ignored: true });
    }

    // Idempotency (Retell retries)
    const exists = await Call.findOne({ callId });
    if (exists) {
      return res.status(200).json({ duplicate: true });
    }

    // ✅ SAFE intent handling
    const intent =
      event?.call_analysis?.intent &&
      ["order", "booking", "inquiry"].includes(event.call_analysis.intent)
        ? event.call_analysis.intent
        : "unknown";

    await Call.create({
      businessId: agent.businessId,
      agentId: agent._id,
      retellAgentId,
      callId,

      callerNumber: event?.from ?? null,
      calleeNumber: event?.to ?? null,

      intent,

      orderData: event?.order ?? null,
      bookingData: event?.booking ?? null,

      summary: event?.call_analysis?.call_summary ?? null,
      transcript: event?.transcript ?? null,

      startedAt: event?.started_at ? new Date(event.started_at) : null,
      endedAt: event?.ended_at ? new Date(event.ended_at) : null,
      durationSeconds: event?.duration_seconds ?? null,
    });

    console.log("✅ Call saved:", callId);
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("❌ Webhook processing error:", err);
    return res.status(500).json({ error: "Webhook failed" });
  }
};