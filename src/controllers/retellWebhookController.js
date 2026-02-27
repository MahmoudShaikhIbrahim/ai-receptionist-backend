// src/controllers/retellWebhookController.js

const Agent = require("../models/Agent");
const Call = require("../models/Call");

exports.handleRetellWebhook = async (req, res) => {
  try {
    const payload = req.body;
    const event = payload.event;

    console.log("📞 RETELL EVENT RECEIVED:", event);

    // We ONLY persist on final events
    if (!["call.ended", "call.completed", "post_call", "call.analyzed"].includes(event)) {
      return res.status(200).json({ ignored: true });
    }

    const callId = payload.call_id || payload.call?.id;
    const retellAgentId = payload.agent_id || payload.call?.agent_id;

    if (!callId || !retellAgentId) {
      console.warn("⚠️ Missing callId or retellAgentId");
      return res.status(200).json({ ignored: true });
    }

    // Resolve agent
    const agent = await Agent.findOne({ retellAgentId });
    if (!agent) {
      console.warn("⚠️ No agent mapped to retellAgentId:", retellAgentId);
      return res.status(200).json({ ignored: true });
    }

    // Persist call (idempotent)
    await Call.findOneAndUpdate(
      { callId },
      {
        callId,
        retellAgentId,
        agentId: agent._id,
        businessId: agent.businessId,

        callerNumber: payload.from || null,
        calleeNumber: payload.to || null,

        transcript: payload.transcript || payload.call?.transcript || null,
        summary: payload.summary || null,

        startedAt: payload.started_at
          ? new Date(payload.started_at)
          : payload.call?.started_at
          ? new Date(payload.call.started_at)
          : null,

        endedAt: payload.ended_at
          ? new Date(payload.ended_at)
          : payload.call?.ended_at
          ? new Date(payload.call.ended_at)
          : null,

        durationSeconds: payload.duration || payload.call?.duration || null,
      },
      { upsert: true, new: true }
    );

    console.log("✅ CALL SAVED:", callId);

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("❌ RETELL WEBHOOK ERROR:", err);
    return res.status(500).json({ error: "internal_error" });
  }
};