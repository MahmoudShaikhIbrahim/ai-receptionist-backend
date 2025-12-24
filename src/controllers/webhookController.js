// src/controllers/webhookController.js
const Agent = require("../models/Agent");
const Call = require("../models/Call");

function normalizeIntent(raw) {
  if (!raw) return "unknown";
  const v = String(raw).trim().toLowerCase();
  if (["order", "booking", "inquiry"].includes(v)) return v;
  return "unknown";
}

function pickSummary(event) {
  return (
    event?.summary ??
    event?.call_analysis?.call_summary ??
    event?.call_analysis?.custom_analysis_data?.detailed_call_summary ??
    null
  );
}

function pickTranscript(event) {
  // Retell payloads vary; keep it defensive.
  if (typeof event?.transcript === "string") return event.transcript;
  if (Array.isArray(event?.transcript)) return JSON.stringify(event.transcript);
  if (event?.transcript_object) return JSON.stringify(event.transcript_object);
  return null;
}

exports.handleWebhook = async (req, res) => {
  try {
    const event = req.body;

    // Minimal log (DO NOT print the whole payload -> Railway rate limit)
    const agentId = event?.agent_id;
    const callId = event?.call_id;

    if (!agentId || !callId) {
      console.warn("Webhook ignored (missing agent_id/call_id)");
      return res.status(200).json({ ignored: true });
    }

    const agent = await Agent.findOne({ retellAgentId: agentId }).lean();
    if (!agent) {
      console.warn("⚠️ Unknown Retell agent:", agentId);
      return res.status(200).json({ ignored: true });
    }

    const doc = {
      businessId: agent.businessId,
      agentId: agent._id,
      retellAgentId: agent.retellAgentId,
      callId,

      callerNumber: event?.from ?? null,
      calleeNumber: event?.to ?? null,

      intent: normalizeIntent(event?.intent),

      orderData: event?.order ?? null,
      bookingData: event?.booking ?? null,

      summary: pickSummary(event),
      transcript: pickTranscript(event),

      startedAt: event?.started_at ? new Date(event.started_at) : null,
      endedAt: event?.ended_at ? new Date(event.ended_at) : null,
      durationSeconds:
        typeof event?.duration_seconds === "number" ? event.duration_seconds : null,
    };

    // Idempotent insert (Retell retries / duplicates)
    await Call.updateOne(
      { callId },
      { $setOnInsert: doc },
      { upsert: true }
    );

    console.log("✅ Call upserted:", callId, "| business:", String(agent.businessId));
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("❌ Webhook processing error:", err?.message || err);
    return res.status(200).json({ received: true }); // keep 200 so Retell stops retry storms
  }
};