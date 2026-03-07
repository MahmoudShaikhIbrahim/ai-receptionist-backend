const Agent = require("../models/Agent");
const Call = require("../models/Call");

/* ======================
   UTILITIES
====================== */

function pick(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

/* ======================
   RETELL NORMALIZER
====================== */

function normalizeRetellCall(payload) {
  const call =
    payload?.call ||
    payload?.data?.call ||
    payload?.payload?.call ||
    payload?.data?.payload?.call ||
    payload?.data ||
    payload;

  const callId =
    call?.call_id ||
    call?.callId ||
    call?.id ||
    payload?.call_id ||
    payload?.id ||
    null;

  const agentId =
    call?.agent_id ||
    call?.agentId ||
    payload?.agent_id ||
    payload?.agentId ||
    null;

  if (!callId || !agentId) {
    console.warn("⚠️ Could not extract callId or agentId");
    return null;
  }

  return {
    ...call,
    call_id: callId,
    agent_id: agentId
  };
}

/* ======================
   RETELL WEBHOOK HANDLER
====================== */

exports.handleRetellWebhook = async (req, res) => {
  try {
    console.log("📩 RETELL EVENT:", req.body?.event);

    const call = normalizeRetellCall(req.body);
    if (!call) {
      return res.status(200).json({ ignored: true });
    }

    const retellAgentId = call.agent_id;
    const callId = call.call_id;

    const agent = await Agent.findOne({ retellAgentId });
    if (!agent) {
      console.warn("⚠️ No agent found for retellAgentId:", retellAgentId);
      return res.status(200).json({ ignored: true });
    }

    await Call.findOneAndUpdate(
      { callId },

      {
        // ✅ REQUIRED FIELDS AT CREATION TIME
        $setOnInsert: {
          callId,
          businessId: agent.businessId,
          agentId: agent._id,
          retellAgentId,
        },

        // ✅ UPDATABLE FIELDS
        $set: {
          callerNumber:
            pick(call, ["from", "caller_number", "callerNumber"]) || null,

          calleeNumber:
            pick(call, ["to", "callee_number", "calleeNumber"]) || null,

          intent: pick(call, ["intent"]) || "unknown",

          summary: pick(call, ["call_analysis"])?.call_summary || null,
          transcript: pick(call, ["transcript"]) || null,

          startedAt: pick(call, ["start_timestamp", "startTimestamp"])
            ? new Date(pick(call, ["start_timestamp", "startTimestamp"]))
            : undefined,

          endedAt: pick(call, ["end_timestamp", "endTimestamp"])
            ? new Date(pick(call, ["end_timestamp", "endTimestamp"]))
            : undefined,

          durationSeconds: pick(call, ["duration_ms", "durationMs"])
            ? Math.round(
                Number(pick(call, ["duration_ms", "durationMs"])) / 1000
              )
            : undefined,
        },
      },

      {
        upsert: true,
        new: true,
      }
    );

    console.log("✅ RETELL CALL SAVED:", callId);
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("❌ RETELL WEBHOOK ERROR:", err);
    return res.status(500).json({ error: "Webhook failed" });
  }
};