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
   Core Allocation Logic (Existing)
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
  const tableFilter = { businessId, isActive: true };
  if (floorId) tableFilter.floorId = floorId;
  if (zone) tableFilter.zone = zone;

  const tables = await Table.find(tableFilter).lean();
  if (!tables.length) return null;

  const blockingBookings = await Booking.find({
    businessId,
    status: { $in: ["confirmed", "seated"] },
    startIso: { $lt: endIso },
    endIso: { $gt: startIso },
  }).lean();

  const blockedTableIds = new Set();
  for (const booking of blockingBookings) {
    for (const t of booking.tables) {
      blockedTableIds.add(String(t.tableId));
    }
  }

  const availableTables = tables.filter(
    (t) => !blockedTableIds.has(String(t._id))
  );

  if (!availableTables.length) return null;

  const singleFit = availableTables
    .filter((t) => t.capacity >= partySize)
    .sort((a, b) => a.capacity - b.capacity)[0];

  let selectedTables = null;

  if (singleFit) {
    selectedTables = [
      { tableId: singleFit._id, capacity: singleFit.capacity },
    ];
  } else {
    const sorted = [...availableTables].sort(
      (a, b) => a.capacity - b.capacity
    );

    const combinations = [];

    function backtrack(startIndex, currentTables, totalCapacity) {
      if (totalCapacity >= partySize) {
        combinations.push([...currentTables]);
        return;
      }

      for (let i = startIndex; i < sorted.length; i++) {
        currentTables.push(sorted[i]);
        backtrack(
          i + 1,
          currentTables,
          totalCapacity + sorted[i].capacity
        );
        currentTables.pop();
      }
    }

    backtrack(0, [], 0);

    if (!combinations.length) return null;

    combinations.sort((a, b) => {
      if (a.length !== b.length) return a.length - b.length;

      const wasteA =
        a.reduce((sum, t) => sum + t.capacity, 0) - partySize;
      const wasteB =
        b.reduce((sum, t) => sum + t.capacity, 0) - partySize;

      return wasteA - wasteB;
    });

    const best = combinations[0];

    selectedTables = best.map((t) => ({
      tableId: t._id,
      capacity: t.capacity,
    }));
  }

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

  return booking.toObject();
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
  const requestedEnd = addMinutes(requestedStart, durationMinutes);

  // 1️⃣ Try requested time first
  const direct = await createBooking({
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

  if (direct) {
    return { success: true, booking: direct };
  }

  // 2️⃣ Search nearest both directions
  const step = 15;
  const maxSteps = Math.floor(searchWindowMinutes / step);

  for (let i = 1; i <= maxSteps; i++) {
    const backwardStart = addMinutes(requestedStart, -step * i);
    const backwardEnd = addMinutes(backwardStart, durationMinutes);

    const forwardStart = addMinutes(requestedStart, step * i);
    const forwardEnd = addMinutes(forwardStart, durationMinutes);

    // Try backward first (closer earlier time)
    const backAttempt = await createBooking({
      businessId,
      startIso: backwardStart,
      endIso: backwardEnd,
      partySize,
      source,
      agentId,
      callId,
      customerName,
      customerPhone,
      notes,
    });

    if (backAttempt) {
      return {
        success: false,
        suggestedTime: formatIso(backwardStart),
      };
    }

    const forwardAttempt = await createBooking({
      businessId,
      startIso: forwardStart,
      endIso: forwardEnd,
      partySize,
      source,
      agentId,
      callId,
      customerName,
      customerPhone,
      notes,
    });

    if (forwardAttempt) {
      return {
        success: false,
        suggestedTime: formatIso(forwardStart),
      };
    }
  }

  return { success: false, suggestedTime: null };
}

module.exports = {
  createBooking,
  findNearestAvailableSlot,
};