// src/controllers/webhookController.js
const Agent = require("../models/Agent");
const Call = require("../models/Call");

exports.handleWebhook = async (req, res) => {
  try {
    const event = req.body;

    // Guard: ignore invalid payloads silently
    if (!event || !event.agent_id || !event.call_id) {
      return res.status(200).json({ ignored: true });
    }

    // PRIMARY ROUTING KEY (as agreed)
    const agent = await Agent.findOne({
      retellAgentId: event.agent_id,
    });

    // Unknown agent → ignore safely
    if (!agent) {
      return res.status(200).json({ ignored: true });
    }

    // Idempotency (Retell retries)
    const exists = await Call.findOne({ callId: event.call_id });
    if (exists) {
      return res.status(200).json({ duplicate: true });
    }

    await Call.create({
      businessId: agent.businessId,
      agentId: agent._id,
      retellAgentId: agent.retellAgentId,
      callId: event.call_id,

      callerNumber: event.from || null,
      calleeNumber: event.to || null,

      intent: event.intent || "unknown",

      orderData: event.order || null,
      bookingData: event.booking || null,

      summary: event.summary || null,
      transcript: event.transcript || null,

      startedAt: event.started_at ? new Date(event.started_at) : null,
      endedAt: event.ended_at ? new Date(event.ended_at) : null,

      durationSeconds: event.duration_seconds || null,
    });

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).json({ error: "Webhook failed" });
  }
};