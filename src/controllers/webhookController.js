exports.handleWebhook = async (req, res) => {
  try {
    const event = req.body;

    if (!event || !event.agent_id || !event.call_id) {
      return res.status(200).json({ ignored: true });
    }

    const agent = await Agent.findOne({
      retellAgentId: event.agent_id,
    });

    if (!agent) {
      console.warn("⚠️ Unknown Retell agent:", event.agent_id);
      return res.status(200).json({ ignored: true });
    }

    const exists = await Call.findOne({ callId: event.call_id });
    if (exists) {
      return res.status(200).json({ duplicate: true });
    }

    // ✅ THIS MUST BE REACHABLE
    await Call.create({
      businessId: agent.businessId,
      agentId: agent._id,
      retellAgentId: agent.retellAgentId,
      callId: event.call_id,

      callerNumber: event.from ?? null,
      calleeNumber: event.to ?? null,

      intent: event.intent ?? "unknown",

      orderData: event.order ?? null,
      bookingData: event.booking ?? null,

      summary: event.call_analysis?.call_summary ?? null,
      transcript: event.transcript ?? null,

      startedAt: event.started_at ? new Date(event.started_at) : null,
      endedAt: event.ended_at ? new Date(event.ended_at) : null,
      durationSeconds: event.duration_seconds ?? null,
    });

    console.log("✅ Call saved:", event.call_id);
    return res.status(200).json({ received: true });

  } catch (err) {
    console.error("❌ Webhook error:", err);
    return res.status(500).json({ error: "Webhook failed" });
  }
};