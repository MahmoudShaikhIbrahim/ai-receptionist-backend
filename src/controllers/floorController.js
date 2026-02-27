const Floor = require("../models/Floor");
const Table = require("../models/Table");
const Booking = require("../models/Booking");

exports.getLiveFloor = async (req, res) => {
  try {
    const businessId = req.businessId;
    const { floorId } = req.params;

    const Business = require("../models/Business");

    // 1️⃣ Validate floor
    const floor = await Floor.findOne({
      _id: floorId,
      businessId,
      isActive: true,
    }).lean();

    if (!floor) {
      return res.status(404).json({ error: "Floor not found" });
    }

    // 2️⃣ Fetch business settings (for upcoming window)
    const business = await Business.findById(businessId).lean();
    const upcomingWindowMinutes =
      business?.liveUpcomingWindowMinutes ?? 30;

    const now = new Date();
    const upcomingLimit = new Date(
      now.getTime() + upcomingWindowMinutes * 60000
    );

    // 3️⃣ Get active tables
    const tables = await Table.find({
      businessId,
      floorId,
      isActive: true,
    }).lean();

    if (!tables.length) {
      return res.json({ floor, tables: [] });
    }

    const tableIdSet = new Set(
      tables.map((t) => String(t._id))
    );

    // 4️⃣ Get relevant bookings ONLY
    const bookings = await Booking.find({
      businessId,
      status: { $in: ["confirmed", "seated"] },
      startIso: { $lt: upcomingLimit },
      endIso: { $gt: now },
    })
      .select("_id tables customerName customerPhone partySize startIso endIso source status")
      .lean();

    const tableBookingMap = new Map();

    for (const booking of bookings) {
      for (const t of booking.tables) {
        const id = String(t.tableId);
        if (tableIdSet.has(id)) {
          tableBookingMap.set(id, booking);
        }
      }
    }

    // 5️⃣ Compute table states
    const result = tables.map((table) => {
      const booking = tableBookingMap.get(String(table._id));

      let visualStatus = "free";
      let bookingPayload = null;

      // Maintenance overrides everything
      if (table.isMaintenance) {
        visualStatus = "maintenance";
      } else if (booking) {
        const isSeatedNow =
          booking.status === "seated" &&
          booking.startIso <= now &&
          booking.endIso > now;

        const isUpcoming =
          booking.status === "confirmed" &&
          booking.startIso >= now &&
          booking.startIso <= upcomingLimit;

        if (isSeatedNow) {
          visualStatus = "seated";
        } else if (isUpcoming) {
          visualStatus = "booked";
        }
      }

      if (booking) {
        bookingPayload = {
          bookingId: booking._id,
          customerName: booking.customerName,
          customerPhone: booking.customerPhone,
          partySize: booking.partySize,
          startIso: booking.startIso,
          endIso: booking.endIso,
          source: booking.source,
          status: booking.status,
        };
      }

      return {
        _id: table._id,
        label: table.label,
        capacity: table.capacity,
        x: table.x,
        y: table.y,
        w: table.w,
        h: table.h,
        zone: table.zone,
        status: visualStatus,
        booking: bookingPayload,
      };
    });

    return res.json({
      floor,
      tables: result,
    });
  } catch (err) {
    console.error("❌ getLiveFloor error:", err);
    return res.status(500).json({
      error: "Failed to load live floor",
    });
  }
};