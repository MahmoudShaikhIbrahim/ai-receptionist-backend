// src/middleware/authMiddleware.js
const jwt = require("jsonwebtoken");
const Business = require("../models/Business");

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    if (!token) {
      return res.status(401).json({ error: "No token provided" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded || !decoded.businessId) {
      return res.status(401).json({ error: "Invalid token" });
    }

    const business = await Business.findById(decoded.businessId);
    if (!business) {
      return res.status(401).json({ error: "Business not found" });
    }

    req.business = {
      id: business._id,
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

module.exports = { requireAuth };