const Booking = require("../models/Booking");
const Table = require("../models/Table");

/* =====================================================
   Helpers
===================================================== */

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

function formatIso(date) {
  return new Date(date).toISOString();
}

/* =====================================================
   Core Table Resolution
===================================================== */

async function findAvailableTables({
  businessId,
  startIso,
  endIso,
  floorId = null,
  zone = null,
}) {
  const tableFilter = { businessId, isActive: true };
  if (floorId) tableFilter.floorId = floorId;
  if (zone) tableFilter.zone = zone;

  const tables = await Table.find(tableFilter).lean();
  console.log("🪑 tables found:", tables.length);

  if (!tables.length) {
    console.log("❌ No active tables found for business");
    return [];
  }

  const blockingBookings = await Booking.find({
    businessId,
    status: { $in: ["confirmed", "seated"] },
    startIso: { $lt: endIso },
    endIso: { $gt: startIso },
  }).lean();

  console.log("⛔ blocking bookings found:", blockingBookings.length);

  const blockedTableIds = new Set();
  for (const booking of blockingBookings) {
    for (const t of booking.tables || []) {
      blockedTableIds.add(String(t.tableId));
    }
  }

  const availableTables = tables.filter(
    (t) => !blockedTableIds.has(String(t._id))
  );

  console.log("✅ available tables:", availableTables.length);
  return availableTables;
}

function chooseTablesForParty(availableTables, partySize) {
  if (!Array.isArray(availableTables) || !availableTables.length) {
    return null;
  }

  const singleFit = availableTables
    .filter((t) => t.capacity >= partySize)
    .sort((a, b) => a.capacity - b.capacity)[0];

  if (singleFit) {
    const selected = [{ tableId: singleFit._id, capacity: singleFit.capacity }];
    console.log("🎯 single table fit found:", {
      tableId: String(singleFit._id),
      capacity: singleFit.capacity,
    });
    return selected;
  }

  const sorted = [...availableTables].sort((a, b) => a.capacity - b.capacity);
  const combinations = [];

  function backtrack(startIndex, currentTables, totalCapacity) {
    if (totalCapacity >= partySize) {
      combinations.push([...currentTables]);
      return;
    }

    for (let i = startIndex; i < sorted.length; i++) {
      currentTables.push(sorted[i]);
      backtrack(i + 1, currentTables, totalCapacity + sorted[i].capacity);
      currentTables.pop();
    }
  }

  backtrack(0, [], 0);
  console.log("🧮 combinations found:", combinations.length);

  if (!combinations.length) {
    console.log("❌ No table combination can satisfy party size");
    return null;
  }

  combinations.sort((a, b) => {
    if (a.length !== b.length) return a.length - b.length;

    const wasteA = a.reduce((sum, t) => sum + t.capacity, 0) - partySize;
    const wasteB = b.reduce((sum, t) => sum + t.capacity, 0) - partySize;

    return wasteA - wasteB;
  });

  const best = combinations[0];
  const selected = best.map((t) => ({
    tableId: t._id,
    capacity: t.capacity,
  }));

  console.log(
    "🎯 combination selected:",
    selected.map((t) => ({
      tableId: String(t.tableId),
      capacity: t.capacity,
    }))
  );

  return selected;
}

async function resolveBookingTables({
  businessId,
  startIso,
  endIso,
  partySize,
  floorId = null,
  zone = null,
}) {
  const availableTables = await findAvailableTables({
    businessId,
    startIso,
    endIso,
    floorId,
    zone,
  });

  if (!availableTables.length) {
    return null;
  }

  return chooseTablesForParty(availableTables, partySize);
}

/* =====================================================
   Core Allocation Logic
===================================================== */

async function createBooking({
  businessId,
  startIso,
  endIso,
  partySize,
  source,
  agentId = null,
  callId = null,
  customerName,
  customerPhone = null,
  notes = null,
  floorId = null,
  zone = null,
}) {

  // Prevent duplicate bookings for the same call
  if (callId) {
    const existingBooking = await Booking.findOne({
      callId,
      status: { $in: ["confirmed", "seated"] },
    }).lean();

    if (existingBooking) {
      console.log("⚠️ Booking already exists for call:", callId);
      return existingBooking;
    }
  }

  console.log("🔎 createBooking called with:", {
    businessId: String(businessId),
    startIso,
    endIso,
    partySize,
    source,
    agentId: agentId ? String(agentId) : null,
    callId,
    customerName,
    floorId: floorId ? String(floorId) : null,
    zone,
  });

  const selectedTables = await resolveBookingTables({
    businessId,
    startIso,
    endIso,
    partySize,
    floorId,
    zone,
  });

  if (!selectedTables) {
    console.log("❌ No table allocation possible");
    return null;
  }

  try {
    const booking = await Booking.create({
      businessId,
      tables: selectedTables,
      agentId,
      callId,
      startIso,
      endIso,
      partySize,
      customerName,
      customerPhone,
      notes,
      source,
      status: "confirmed",
    });

    console.log("✅ Booking created:", String(booking._id));
    return booking.toObject();
  } catch (err) {
    console.error("❌ Booking.create failed:", err);
    throw err;
  }
}

/* =====================================================
   Option B: Nearest Slot Search
===================================================== */

async function findNearestAvailableSlot({
  businessId,
  requestedStart,
  durationMinutes = 90,
  partySize,
  source,
  agentId,
  callId,
  customerName,
  customerPhone,
  notes,
  searchWindowMinutes = 120,
}) {
  console.log("🚀 findNearestAvailableSlot called with:", {
    businessId: String(businessId),
    requestedStart,
    durationMinutes,
    partySize,
    source,
    agentId: agentId ? String(agentId) : null,
    callId,
    customerName,
    searchWindowMinutes,
  });

  const requestedEnd = addMinutes(requestedStart, durationMinutes);

  const directTables = await resolveBookingTables({
    businessId,
    startIso: requestedStart,
    endIso: requestedEnd,
    partySize,
  });

  if (directTables) {
  const directBooking = await createBooking({
    businessId,
    startIso: requestedStart,
    endIso: requestedEnd,
    partySize,
    source,
    agentId,
    callId,
    customerName,
    customerPhone,
    notes,
  });

    console.log("✅ Direct booking success:", String(directBooking._id));

    return {
      success: true,
      booking: directBooking.toObject(),
    };
  }

  const step = 15;
  const maxSteps = Math.floor(searchWindowMinutes / step);

  for (let i = 1; i <= maxSteps; i++) {
    const backwardStart = addMinutes(requestedStart, -step * i);
    const backwardEnd = addMinutes(backwardStart, durationMinutes);

    const backwardTables = await resolveBookingTables({
      businessId,
      startIso: backwardStart,
      endIso: backwardEnd,
      partySize,
    });

    if (backwardTables) {
      console.log("🕒 Suggested earlier time:", backwardStart);
      return {
        success: false,
        suggestedTime: formatIso(backwardStart),
      };
    }

    const forwardStart = addMinutes(requestedStart, step * i);
    const forwardEnd = addMinutes(forwardStart, durationMinutes);

    const forwardTables = await resolveBookingTables({
      businessId,
      startIso: forwardStart,
      endIso: forwardEnd,
      partySize,
    });

    if (forwardTables) {
      console.log("🕒 Suggested later time:", forwardStart);
      return {
        success: false,
        suggestedTime: formatIso(forwardStart),
      };
    }
  }

  console.log("❌ No slot found in search window");
  return { success: false, suggestedTime: null };
}

module.exports = {
  createBooking,
  findNearestAvailableSlot,
};