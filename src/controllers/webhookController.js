// src/controllers/webhookController.js
const Agent = require("../models/Agent");
const Call = require("../models/Call");

exports.handleWebhook = async (req, res) => {
  try {
    const payload = req.body;

    console.log("📞 Retell webhook received:", JSON.stringify(payload, null, 2));

    // ---- NORMALIZE RETELL PAYLOAD ----
    const data =
      payload?.data ||
      payload?.call ||
      payload;

    const callId =
      data?.call_id ||
      data?.id ||
      null;

    const retellAgentId =
      data?.agent_id ||
      data?.agentId ||
      null;

    if (!callId || !retellAgentId) {
      console.warn("⚠️ Missing callId or agentId. Ignored.");
      return res.status(200).json({ ignored: true });
    }

    // ---- FIND AGENT (PRIMARY ROUTING KEY) ----
    const agent = await Agent.findOne({ retellAgentId });

    if (!agent) {
      console.warn("⚠️ Unknown Retell agent:", retellAgentId);
      return res.status(200).json({ ignored: true });
    }

    // ---- IDEMPOTENCY ----
    const exists = await Call.findOne({ callId });
    if (exists) {
      return res.status(200).json({ duplicate: true });
    }

    // ---- SAVE CALL ----
    await Call.create({
      businessId: agent.businessId,
      agentId: agent._id,
      retellAgentId,

      callId,

      callerNumber: data?.from || null,
      calleeNumber: data?.to || null,

      intent: data?.intent || null,
      summary: data?.summary || null,
      transcript: data?.transcript || null,

      orderData: data?.order || null,
      bookingData: data?.booking || null,

      startedAt: data?.started_at
        ? new Date(data.started_at)
        : null,

      endedAt: data?.ended_at
        ? new Date(data.ended_at)
        : null,

      durationSeconds: data?.duration_seconds || null,
    });

    console.log("✅ Call saved:", callId);

    return res.status(200).json({ saved: true });
  } catch (err) {
    console.error("❌ Webhook processing error:", err);
    return res.status(500).json({ error: "Webhook failed" });
  }
};