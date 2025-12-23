// src/controllers/businessController.js
const Business = require("../models/Business");

const ALLOWED_PROFILE_UPDATES = new Set([
  "businessName",
  "industry",
  "phone",
  "address",
  "timezone",
  "openingHours",
]);

function pickAllowedUpdates(body) {
  const updates = {};
  for (const [key, value] of Object.entries(body || {})) {
    if (ALLOWED_PROFILE_UPDATES.has(key)) updates[key] = value;
  }
  return updates;
}

function assertNoForbiddenKeys(body) {
  const forbidden = [];
  for (const key of Object.keys(body || {})) {
    if (!ALLOWED_PROFILE_UPDATES.has(key)) forbidden.push(key);
  }
  if (forbidden.length > 0) {
    const err = new Error(`Forbidden fields: ${forbidden.join(", ")}`);
    err.statusCode = 400;
    throw err;
  }
}

exports.getMe = async (req, res) => {
  const business = await Business.findById(req.businessId).lean();
  if (!business) return res.status(404).json({ error: "Business not found" });
  return res.json({ business });
};

exports.updateProfile = async (req, res) => {
  // STRICT mode: if request includes any forbidden keys, reject.
  // This prevents accidental writes to plan/status/email/_id/etc.
  assertNoForbiddenKeys(req.body);

  const updates = pickAllowedUpdates(req.body);

  // Minimal required server-side checks (keep it stable)
  if ("businessName" in updates && !String(updates.businessName || "").trim()) {
    return res.status(400).json({ error: "businessName is required" });
  }
  if ("phone" in updates && !String(updates.phone || "").trim()) {
    return res.status(400).json({ error: "phone is required" });
  }
  if ("timezone" in updates && !String(updates.timezone || "").trim()) {
    return res.status(400).json({ error: "timezone is required" });
  }

  const business = await Business.findByIdAndUpdate(
    req.businessId,
    { $set: updates },
    { new: true, runValidators: true }
  ).lean();

  if (!business) return res.status(404).json({ error: "Business not found" });
  return res.json({ business });
};