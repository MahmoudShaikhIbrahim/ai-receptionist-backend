const Booking = require("../models/Booking");
const Table = require("../models/Table");
const Agent = require("../models/Agent");

/*
  PRODUCTION BOOKING ENGINE
  - Auto assigns table
  - Prevents table collision
  - Works for AI calls
*/

exports.createAIBooking = async (req, res) => {
  try {
    const { partySize, startTime, customerName, callId } = req.body;

    if (!partySize || !startTime || !customerName) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const start = new Date(startTime);

    if (isNaN(start.getTime())) {
      return res.status(400).json({ error: "Invalid startTime" });
    }

    // 🔥 Duration = 90 minutes (change later if needed)
    const end = new Date(start.getTime() + 90 * 60000);

    // Resolve agent → business
    const agent = await Agent.findOne({ retellAgentId: req.body.retellAgentId });
    if (!agent) {
      return res.status(400).json({ error: "Agent not found" });
    }

    const businessId = agent.businessId;

    // 1️⃣ Get all active tables that can fit party
    const tables = await Table.find({
      businessId,
      isActive: true,
      capacity: { $gte: partySize },
    }).sort({ capacity: 1 });

    if (!tables.length) {
      return res.status(400).json({ error: "No tables available" });
    }

    // 2️⃣ Find first available table (no time overlap)
    let selectedTable = null;

    for (const table of tables) {
      const overlapping = await Booking.findOne({
        tableId: table._id,
        status: "confirmed",
        $or: [
          {
            startTime: { $lt: end },
            endTime: { $gt: start },
          },
        ],
      });

      if (!overlapping) {
        selectedTable = table;
        break;
      }
    }

    if (!selectedTable) {
      return res.status(400).json({ error: "No available tables at that time" });
    }

    // 3️⃣ Create booking
    const booking = await Booking.create({
      businessId,
      tableId: selectedTable._id,
      agentId: agent._id,
      callId: callId || null,
      startTime: start,
      endTime: end,
      partySize,
      customerName,
      customerPhone: req.body.customerPhone || null,
      source: "ai",
      status: "confirmed",
    });

    return res.json({
      success: true,
      table: selectedTable.name,
      bookingId: booking._id,
    });

  } catch (err) {
    console.error("❌ AI BOOKING ENGINE ERROR:", err);
    return res.status(500).json({ error: "Booking failed" });
  }
};