// src/services/bookingService.js

const Booking = require("../models/Booking");
const Table = require("../models/Table");

/**
 * Check time overlap
 */
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

/**
 * Core booking allocation + creation engine
 */
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
  // 1️⃣ Get active tables
  const tableFilter = { businessId, isActive: true };
  if (floorId) tableFilter.floorId = floorId;
  if (zone) tableFilter.zone = zone;

  const tables = await Table.find(tableFilter).lean();
  if (!tables.length) return null;

  // 2️⃣ Get blocking bookings
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

  // 3️⃣ Try single-table fit
  const singleFit = availableTables
    .filter((t) => t.capacity >= partySize)
    .sort((a, b) => a.capacity - b.capacity)[0];

  let selectedTables = null;

  if (singleFit) {
    selectedTables = [
      { tableId: singleFit._id, capacity: singleFit.capacity },
    ];
  } else {
    // 4️⃣ Combination logic
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

  // 5️⃣ Create booking
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

module.exports = { createBooking };