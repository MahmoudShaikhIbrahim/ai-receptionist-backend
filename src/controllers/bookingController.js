// src/controllers/bookingController.js
const Table = require("../models/Table");
const Booking = require("../models/Booking");
const Agent = require("../models/Agent");
const Business = require("../models/Business");
const { createBooking } = require("../services/bookingService");

/* =====================================================
   LIST BOOKINGS (Dashboard)
===================================================== */
exports.listBookings = async (req, res) => {
  try {
    const businessId = req.businessId;

    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit || "20", 10), 1),
      100
    );

    const [items, total] = await Promise.all([
      Booking.find({ businessId })
        .sort({ startIso: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("tables.tableId", "label capacity zone")
        .lean(),
      Booking.countDocuments({ businessId }),
    ]);

    return res.json({
      data: items,
      pagination: { page, limit, total },
    });
  } catch (err) {
    console.error("❌ listBookings error:", err);
    return res.status(500).json({ error: "Failed to load bookings" });
  }
};

/* =====================================================
   AI BOOKING
===================================================== */
exports.createBookingAI = async (req, res) => {
  try {
    const retellAgentId =
      req.headers["x-retell-agent-id"] ||
      req.headers["x-retell-agentid"] ||
      null;

    if (!retellAgentId) {
      return res.status(200).json({
        status: "ERROR",
        assistantMessage: "I can’t identify the restaurant.",
        endCall: false,
      });
    }

    const agent = await Agent.findOne({ retellAgentId }).lean();
    if (!agent?.businessId) {
      return res.status(200).json({
        status: "ERROR",
        assistantMessage: "I can’t identify the restaurant.",
        endCall: false,
      });
    }

    const business = await Business.findById(agent.businessId).lean();
    if (!business?.isActive) {
      return res.status(200).json({
        status: "ERROR",
        assistantMessage: "The restaurant is currently unavailable.",
        endCall: false,
      });
    }

    const {
      startTime,
      partySize,
      customerName,
      customerPhone,
      callId,
      notes,
      floorId,
      zone,
    } = req.body || {};

    if (!startTime || !partySize || !customerName) {
      return res.status(200).json({
        status: "ERROR",
        assistantMessage: "I need the time, number of guests, and name.",
        endCall: false,
      });
    }

    const start = new Date(startTime);
    if (isNaN(start)) {
      return res.status(200).json({
        status: "ERROR",
        assistantMessage: "Invalid time.",
        endCall: false,
      });
    }

    const end = new Date(
      start.getTime() +
        business.defaultDiningDurationMinutes * 60000
    );

    const booking = await createBooking({
      businessId: business._id,
      startIso: start,
      endIso: end,
      partySize: Number(partySize),
      source: "ai",
      agentId: agent._id,
      callId: callId || null,
      customerName: String(customerName).trim(),
      customerPhone: customerPhone
        ? String(customerPhone).trim()
        : null,
      notes: notes ? String(notes).trim() : null,
      floorId: floorId || null,
      zone: zone || null,
    });

    if (!booking) {
      return res.status(200).json({
        status: "NO_AVAILABILITY",
        assistantMessage: "That time isn’t available.",
        endCall: false,
      });
    }

    return res.status(200).json({
      status: "CONFIRMED",
      bookingId: booking._id.toString(),
      assistantMessage: "Your table is booked.",
      endCall: false,
    });
  } catch (err) {
    console.error("❌ createBookingAI error:", err);
    return res.status(200).json({
      status: "ERROR",
      assistantMessage: "Something went wrong.",
      endCall: false,
    });
  }
};

/* =====================================================
   DASHBOARD MANUAL BOOKING
===================================================== */
exports.createBookingManual = async (req, res) => {
  try {
    const businessId = req.businessId;
    const business = await Business.findById(businessId).lean();

    const {
      startTime,
      partySize,
      customerName,
      customerPhone,
      notes,
      floorId,
      zone,
      seatNow = false,
    } = req.body || {};

    if (!startTime || !partySize || !customerName) {
      return res.status(400).json({
        error: "Missing required fields",
      });
    }

    const start = new Date(startTime);
    if (isNaN(start)) {
      return res.status(400).json({
        error: "Invalid start time",
      });
    }

    const end = new Date(
      start.getTime() +
        business.defaultDiningDurationMinutes * 60000
    );

    const booking = await createBooking({
      businessId,
      startIso: start,
      endIso: end,
      partySize: Number(partySize),
      source: "dashboard",
      customerName: String(customerName).trim(),
      customerPhone: customerPhone
        ? String(customerPhone).trim()
        : null,
      notes: notes ? String(notes).trim() : null,
      floorId: floorId || null,
      zone: zone || null,
    });

    if (!booking) {
      return res
        .status(409)
        .json({ error: "No availability for that time" });
    }

    // If walk-in seating
    if (seatNow) {
      await Booking.findByIdAndUpdate(booking._id, {
        status: "seated",
      });
      booking.status = "seated";
    }

    return res.json({ success: true, booking });
  } catch (err) {
    console.error("❌ createBookingManual error:", err);
    return res.status(500).json({
      error: "Failed to create booking",
    });
  }
};

/* =====================================================
   UPDATE BOOKING STATUS
===================================================== */
exports.updateBookingStatus = async (req, res) => {
  try {
    const businessId = req.businessId;
    const { id } = req.params;
    const { status } = req.body;

    const allowed = [
      "confirmed",
      "seated",
      "completed",
      "cancelled",
      "no_show",
    ];

    if (!allowed.includes(status)) {
      return res.status(400).json({
        error: "Invalid status",
      });
    }

    const booking = await Booking.findOneAndUpdate(
      { _id: id, businessId },
      { status },
      { new: true }
    );

    if (!booking) {
      return res.status(404).json({
        error: "Booking not found",
      });
    }

    return res.json({ success: true, booking });
  } catch (err) {
    console.error("❌ updateBookingStatus error:", err);
    return res.status(500).json({
      error: "Failed to update booking status",
    });
  }
};

/* =====================================================
   LIVE TABLE STATUS (Dashboard)
===================================================== */
exports.getLiveTableStatus = async (req, res) => {
  try {
    const businessId = req.businessId;

    const { startTime, endTime } = req.query;

    let start;
    let end;

    if (startTime && endTime) {
      start = new Date(startTime);
      end = new Date(endTime);

      if (isNaN(start) || isNaN(end)) {
        return res.status(400).json({ error: "Invalid startTime or endTime" });
      }
    } else {
      start = new Date();
      end = new Date(start.getTime() + 90 * 60000);
    }

    // 1️⃣ Fetch active tables
    const tables = await Table.find({
      businessId,
      isActive: true,
    }).lean();

    // 2️⃣ Fetch overlapping bookings
    const bookings = await Booking.find({
      businessId,
      status: { $in: ["confirmed", "seated"] },
      startIso: { $lt: end },
      endIso: { $gt: start },
    }).lean();

    // 3️⃣ Map tableId -> booking
    const tableBookingMap = new Map();

    for (const booking of bookings) {
      for (const t of booking.tables) {
        tableBookingMap.set(String(t.tableId), booking);
      }
    }

    // 4️⃣ Build response
    const result = tables.map((table) => {
      const booking = tableBookingMap.get(String(table._id));

      if (!booking) {
        return {
          tableId: table._id,
          label: table.label,
          capacity: table.capacity,
          floorId: table.floorId,
          zone: table.zone,
          status: "free",
          booking: null,
        };
      }

      return {
        tableId: table._id,
        label: table.label,
        capacity: table.capacity,
        floorId: table.floorId,
        zone: table.zone,
        status: booking.status === "seated" ? "seated" : "booked",
        booking: {
          id: booking._id,
          customerName: booking.customerName,
          partySize: booking.partySize,
          source: booking.source,
          startIso: booking.startIso,
          endIso: booking.endIso,
        },
      };
    });

    return res.json({ data: result });
  } catch (err) {
    console.error("❌ getLiveTableStatus error:", err);
    return res.status(500).json({ error: "Failed to load live tables" });
  }
};