const Agent = require("../models/Agent");
const Call = require("../models/Call");

// Small helper: get nested value safely
function get(obj, path) {
  return path.split(".").reduce((acc, key) => (acc && acc[key] != null ? acc[key] : null), obj);
}

// Some providers wrap the real payload inside `data` / `payload`
function unwrap(raw) {
  if (!raw || typeof raw !== "object") return raw;
  return raw.data || raw.payload || raw.body || raw;
}

function extractIds(rawEvent) {
  const e = unwrap(rawEvent);

  // Support MANY possible shapes
  const retellAgentId =
    get(e, "agent.id") ||
    get(e, "agent.agent_id") ||
    get(e, "agentId") ||
    get(e, "agent_id") ||
    get(e, "retell_agent_id") ||
    get(e, "retellAgentId");

  const callId =
    get(e, "call.id") ||
    get(e, "call.call_id") ||
    get(e, "callId") ||
    get(e, "call_id");

  return { e, retellAgentId, callId };
}

function normalizeIntent(rawIntent) {
  const allowed = new Set(["order", "booking", "inquiry"]);
  if (typeof rawIntent === "string" && allowed.has(rawIntent)) return rawIntent;
  return "unknown";
}

exports.handleWebhook = async (req, res) => {
  try {
    const raw = req.body;
    const { e, retellAgentId, callId } = extractIds(raw);

    if (!retellAgentId || !callId) {
      // Minimal debug that won’t spam huge logs
      console.warn("Webhook ignored (missing ids)", {
        topLevelKeys: raw && typeof raw === "object" ? Object.keys(raw) : typeof raw,
        agentKeys: e?.agent && typeof e.agent === "object" ? Object.keys(e.agent) : typeof e?.agent,
        callKeys: e?.call && typeof e.call === "object" ? Object.keys(e.call) : typeof e?.call,
      });
      return res.status(200).json({ ignored: true });
    }

    const agent = await Agent.findOne({ retellAgentId });
    if (!agent) {
      console.warn("Unknown Retell agent:", retellAgentId);
      return res.status(200).json({ ignored: true });
    }

    const exists = await Call.findOne({ callId });
    if (exists) return res.status(200).json({ duplicate: true });

    const intent = normalizeIntent(get(e, "call_analysis.intent") || get(e, "intent"));

    await Call.create({
      businessId: agent.businessId,
      agentId: agent._id,
      retellAgentId,
      callId,

      callerNumber: get(e, "from") ?? null,
      calleeNumber: get(e, "to") ?? null,

      intent,

      orderData: get(e, "order") ?? null,
      bookingData: get(e, "booking") ?? null,

      summary: get(e, "call_analysis.call_summary") ?? get(e, "summary") ?? null,
      transcript: get(e, "transcript") ?? null,

      startedAt: get(e, "started_at") ? new Date(get(e, "started_at")) : null,
      endedAt: get(e, "ended_at") ? new Date(get(e, "ended_at")) : null,
      durationSeconds: get(e, "duration_seconds") ?? null,
    });

    console.log("✅ Call saved:", callId);
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("❌ Webhook processing error:", err);
    return res.status(500).json({ error: "Webhook failed" });
  }
};