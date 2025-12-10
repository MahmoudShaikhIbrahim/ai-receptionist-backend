// src/routes/authRoutes.js

const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const Business = require("../models/Business");
const Agent = require("../models/Agent");

const router = express.Router();

const JWT_EXPIRES_IN = "7d";

// Create JWT for a business
function createToken(business) {
  return jwt.sign(
    {
      businessId: business._id,
      email: business.email,
      businessName: business.businessName,
      businessType: business.businessType,
    },
    process.env.JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

// Very basic system prompt generator for now (we'll evolve later)
function generateSystemPrompt({ businessName, businessType, languagePreference, timezone }) {
  const arabicFirst = languagePreference === "ar";

  const baseIntro = arabicFirst
    ? `أنت موظف استقبال افتراضي محترف لمكان يسمى ${businessName}. أنت تتحدث العربية والإنجليزية بطلاقة. رد أولاً باللغة العربية مع إمكانية المتابعة بالإنجليزية إذا احتاج المتصل.`
    : `You are a professional virtual receptionist for a place called ${businessName}. You speak English and Arabic fluently. Start in English but you can continue in Arabic if the caller prefers.`;

  const bookingLogicByType = {
    restaurant: "Your main job is to handle table bookings, guest count, date/time, and special requests, and collect the caller name and phone number.",
    cafe: "Your main job is to handle pickup orders and (if allowed) table bookings, and answer basic menu and opening hours questions.",
    clinic: "Your main job is to handle appointment bookings, select the correct department/doctor, and collect patient name and phone number. Never give medical advice or diagnosis.",
    hospital: "Your main job is to route the caller to the correct department and handle appointment requests. For emergencies, always instruct them to call local emergency services immediately. Never give medical advice.",
    salon: "Your main job is to handle appointment bookings, service selection, staff preference, and collect the caller name and phone number.",
    hotel: "Your main job is to handle room booking inquiries, dates, number of guests, and basic hotel information. Never confirm final prices if they are not provided explicitly.",
  };

  const businessLogic = bookingLogicByType[businessType] || "Your main job is to handle inquiries and bookings in a professional way.";

  const closing = `Always be polite, concise, and keep the conversation focused. The business timezone is ${timezone}. Never hallucinate information. If you don't know something, say you will forward the request to the staff.`;

  return `${baseIntro}\n\n${businessLogic}\n\n${closing}`;
}

// =============================
//  SIGNUP (Business registration)
//  POST /auth/signup
// =============================
router.post("/signup", async (req, res) => {
  try {
    const { businessName, email, password, businessType } = req.body;

    if (!businessName || !email || !password || !businessType) {
      return res
        .status(400)
        .json({ error: "businessName, email, password and businessType are required" });
    }

    const existing = await Business.findOne({ email });
    if (existing) {
      return res.status(400).json({ error: "Email already registered" });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const business = await Business.create({
      businessName,
      email,
      passwordHash,
      businessType,
      // Rest (ownerName, phone, timezone, languagePreference) can be edited later in settings
    });

    // Auto-create default agent for this business
    const defaultLanguagePreference =
      business.businessType === "restaurant" || business.businessType === "cafe"
        ? "ar"
        : "en";

    const systemPrompt = generateSystemPrompt({
      businessName: business.businessName,
      businessType: business.businessType,
      languagePreference: defaultLanguagePreference,
      timezone: business.timezone || "Asia/Dubai",
    });

    const agent = await Agent.create({
      businessId: business._id,
      name: `${business.businessName} AI Receptionist`,
      businessType: business.businessType,
      languagePreference: defaultLanguagePreference,
      systemPrompt,
      greetingMessage: "",
      fallbackMessage: "",
      closingMessage: "",
      openingHours: {},
    });

    business.agentId = agent._id;
    await business.save();

    const token = createToken(business);

    res.status(201).json({
      message: "Business registered and agent created successfully",
      token,
      business: {
        id: business._id,
        businessName: business.businessName,
        email: business.email,
        businessType: business.businessType,
      },
      agent,
    });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// =============================
//  LOGIN (Business)
//  POST /auth/login
// =============================
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }

    const business = await Business.findOne({ email });
    if (!business) {
      return res.status(400).json({ error: "Invalid email or password" });
    }

    const isMatch = await bcrypt.compare(password, business.passwordHash);
    if (!isMatch) {
      return res.status(400).json({ error: "Invalid email or password" });
    }

    const token = createToken(business);

    res.json({
      message: "Login success",
      token,
      business: {
        id: business._id,
        businessName: business.businessName,
        email: business.email,
        businessType: business.businessType,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;