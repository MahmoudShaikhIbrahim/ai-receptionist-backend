// src/controllers/bookingEngineController.js

const Agent = require("../models/Agent");
const {
  findNearestAvailableSlot,
} = require("../services/bookingService");

/*
  AI Booking Engine
  - Uses centralized bookingService
  - Supports nearest time suggestion (Option B)
  - Fully aligned with Booking schema
*/

exports.createAIBooking = async (req, res) => {
  try {
    const {
      partySize,
      startTime,
      customerName,
      callId,
      retellAgentId,
      customerPhone,
    } = req.body;

    /* ===============================
       Validation
    =============================== */

    if (!partySize || !startTime || !customerName || !retellAgentId) {
      return res.status(400).json({
        error: "Missing required fields",
      });
    }

    const requestedStart = new Date(startTime);

    if (isNaN(requestedStart.getTime())) {
      return res.status(400).json({
        error: "Invalid startTime",
      });
    }

    /* ===============================
       Resolve Agent → Business
    =============================== */

    const agent = await Agent.findOne({
      retellAgentId,
    });

    if (!agent) {
      return res.status(400).json({
        error: "Agent not found",
      });
    }

    const businessId = agent.businessId;

    /* ===============================
       Attempt Booking (Option B)
    =============================== */

    const result = await findNearestAvailableSlot({
      businessId,
      requestedStart,
      durationMinutes: 90,
      partySize: Number(partySize),
      source: "ai",
      agentId: agent._id,
      callId: callId || null,
      customerName,
      customerPhone: customerPhone || null,
      notes: null,
      searchWindowMinutes: 120,
    });

    /* ===============================
       Response Structure
       (Retell Friendly)
    =============================== */

    if (result.success) {
      return res.json({
        success: true,
        bookingId: result.booking._id,
        startIso: result.booking.startIso,
        endIso: result.booking.endIso,
        message: "Booking confirmed",
      });
    }

    if (result.suggestedTime) {
      return res.json({
        success: false,
        suggestedTime: result.suggestedTime,
        message: "Requested time unavailable. Suggested alternative.",
      });
    }

    return res.json({
      success: false,
      suggestedTime: null,
      message: "No available slots within search window.",
    });
  } catch (err) {
    console.error("❌ AI BOOKING ENGINE ERROR:", err);

    return res.status(500).json({
      error: "Booking failed",
    });
  }
};