// src/middleware/authMiddleware.js
const jwt = require("jsonwebtoken");
const Business = require("../models/Business");

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : null;

    if (!token) {
      return res.status(401).json({ error: "No token provided" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Accept BOTH shapes (older/newer) to stop breaking everything.
    const businessId = decoded?.businessId || decoded?.id;

    if (!businessId) {
      return res.status(401).json({ error: "Invalid token" });
    }

    const business = await Business.findById(businessId);
    if (!business) {
      return res.status(401).json({ error: "Business not found" });
    }

    // Keep compatibility with your controllers/routes
    req.businessId = business._id.toString();
    req.business = {
      id: business._id.toString(),
      email: business.email,
      businessName: business.businessName,
      businessType: business.businessType,
      languagePreference: business.languagePreference,
      timezone: business.timezone,
    };

    next();
  } catch (err) {
    console.error("Auth error:", err);
    return res.status(401).json({ error: "Unauthorized" });
  }
}

module.exports = requireAuth;
module.exports.requireAuth = requireAuth;