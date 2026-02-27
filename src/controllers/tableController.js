// src/controllers/tableController.js

const Table = require("../models/Table");
const Floor = require("../models/Floor");
const Booking = require("../models/Booking");
const Business = require("../models/Business");

exports.createTable = async (req, res) => {
  try {
    const { label, capacity, floorId, x, y, w, h, zone } = req.body;

    // Required validation
    if (!label || !capacity) {
      return res.status(400).json({
        error: "Label and capacity are required",
      });
    }

    // Floor ownership validation
    if (floorId) {
      const floor = await Floor.findOne({
        _id: floorId,
        businessId: req.businessId,
      });

      if (!floor) {
        return res.status(400).json({
          error: "Invalid floor for this business",
        });
      }
    }

    const table = await Table.create({
      businessId: req.businessId,
      label: String(label).trim(),
      capacity: Number(capacity),
      floorId: floorId || null,
      x: x ?? 0,
      y: y ?? 0,
      w: w ?? 80,
      h: h ?? 80,
      zone: zone ?? null,
    });

    return res.status(201).json({ table });
  } catch (err) {
    console.error("CREATE TABLE error:", err);

    if (err.code === 11000) {
      return res.status(409).json({
        error: "Table label already exists for this business",
      });
    }

    if (err.name === "ValidationError") {
      return res.status(400).json({
        error: err.message,
      });
    }

    return res.status(500).json({
      error: "Unexpected server error while creating table",
    });
  }
};

exports.getTables = async (req, res) => {
  try {
    const includeInactive =
      req.query.includeInactive === "true" || req.query.includeInactive === "1";

    const filter = { businessId: req.businessId };

    // Default behavior: only active tables
    if (!includeInactive) {
      filter.isActive = true;
    }

    const tables = await Table.find(filter).sort({ label: 1 });

    return res.json({ tables });
  } catch (err) {
    console.error("GET TABLES error:", err);
    return res.status(500).json({
      error: "Failed to fetch tables",
    });
  }
};

exports.deleteTable = async (req, res) => {
  try {
    const table = await Table.findOne({
      _id: req.params.id,
      businessId: req.businessId,
    });

    if (!table) {
      return res.status(404).json({ error: "Table not found" });
    }

    table.isActive = false;
    await table.save();

    return res.json({ success: true });
  } catch (err) {
    console.error("DELETE TABLE error:", err);
    return res.status(500).json({
      error: "Failed to delete table",
    });
  }
};

exports.updateTable = async (req, res) => {
  try {
    const table = await Table.findOne({
      _id: req.params.id,
      businessId: req.businessId,
    });

    if (!table) {
      return res.status(404).json({ error: "Table not found" });
    }

    const { label, capacity, floorId, x, y, w, h, zone, isActive } = req.body;

    // Floor validation if provided
    if (floorId !== undefined && floorId !== null) {
      const floor = await Floor.findOne({
        _id: floorId,
        businessId: req.businessId,
      });

      if (!floor) {
        return res.status(400).json({
          error: "Invalid floor for this business",
        });
      }

      table.floorId = floorId;
    }

    // Label update
    if (label !== undefined) {
      const trimmed = String(label).trim();
      if (!trimmed) {
        return res.status(400).json({
          error: "Label cannot be empty",
        });
      }
      table.label = trimmed;
    }

    // Capacity update
    if (capacity !== undefined) {
      table.capacity = Number(capacity);
    }

    // Layout updates
    if (x !== undefined) table.x = x;
    if (y !== undefined) table.y = y;
    if (w !== undefined) table.w = w;
    if (h !== undefined) table.h = h;

    if (zone !== undefined) table.zone = zone ?? null;
    if (isActive !== undefined) table.isActive = Boolean(isActive);

    await table.save();

    return res.json({ table });
  } catch (err) {
    console.error("UPDATE TABLE error:", err);

    if (err.code === 11000) {
      return res.status(409).json({
        error: "Table label already exists for this business",
      });
    }

    if (err.name === "ValidationError") {
      return res.status(400).json({
        error: err.message,
      });
    }

    return res.status(500).json({
      error: "Failed to update table",
    });
  }
};

exports.hardDeleteTable = async (req, res) => {
  try {
    const deleted = await Table.findOneAndDelete({
      _id: req.params.id,
      businessId: req.businessId,
    });

    if (!deleted) {
      return res.status(404).json({ error: "Table not found" });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("HARD DELETE TABLE error:", err);
    return res.status(500).json({
      error: "Failed to hard delete table",
    });
  }
};

exports.restoreTable = async (req, res) => {
  try {
    const table = await Table.findOne({
      _id: req.params.id,
      businessId: req.businessId,
    });

    if (!table) {
      return res.status(404).json({ error: "Table not found" });
    }

    if (table.isActive) {
      return res.status(400).json({
        error: "Table is already active",
      });
    }

    table.isActive = true;
    await table.save();

    return res.json({ table });
  } catch (err) {
    console.error("RESTORE TABLE error:", err);

    if (err.code === 11000) {
      return res.status(409).json({
        error: "Table label already exists for this business",
      });
    }

    return res.status(500).json({
      error: "Failed to restore table",
    });
  }
};

/* =====================================================
   WALK-IN SEATING
   POST /tables/:id/seat
   - Creates an immediate seated booking for this table
   - No name/phone required
   - Prevents seating if table has an overlapping active booking
===================================================== */
exports.seatTableWalkIn = async (req, res) => {
  try {
    const businessId = req.businessId;
    const tableId = req.params.id;

    const table = await Table.findOne({
      _id: tableId,
      businessId,
      isActive: true,
    }).lean();

    if (!table) {
      return res.status(404).json({ error: "Table not found" });
    }

    const business = await Business.findById(businessId)
      .select("defaultDiningDurationMinutes")
      .lean();

    const durationMinutes = Number(
      business?.defaultDiningDurationMinutes ?? 90
    );

    const now = new Date();
    const end = new Date(now.getTime() + durationMinutes * 60 * 1000);

    // Optional partySize (defaults to table capacity)
    const rawPartySize = req.body?.partySize;
    let partySize = table.capacity;

    if (rawPartySize !== undefined && rawPartySize !== null && rawPartySize !== "") {
      const parsed = Number(rawPartySize);
      if (!Number.isFinite(parsed) || parsed < 1) {
        return res.status(400).json({ error: "Invalid partySize" });
      }
      if (parsed > table.capacity) {
        return res.status(400).json({
          error: "partySize cannot exceed table capacity",
        });
      }
      partySize = parsed;
    }

    // Block if overlapping confirmed/seated booking exists for this table
    const overlapping = await Booking.findOne({
      businessId,
      status: { $in: ["confirmed", "seated"] },
      "tables.tableId": table._id,
      startIso: { $lt: end },
      endIso: { $gt: now },
    })
      .select("_id status startIso endIso customerName partySize source")
      .lean();

    if (overlapping) {
      return res.status(409).json({
        error: "Table is not available",
        booking: {
          id: overlapping._id,
          status: overlapping.status,
          startIso: overlapping.startIso,
          endIso: overlapping.endIso,
          customerName: overlapping.customerName,
          partySize: overlapping.partySize,
          source: overlapping.source,
        },
      });
    }

    const booking = await Booking.create({
      businessId,
      tables: [{ tableId: table._id, capacity: table.capacity }],
      agentId: null,
      callId: null,
      startIso: now,
      endIso: end,
      partySize,
      customerName: null,
      customerPhone: null,
      notes: null,
      source: "manual",
      status: "seated",
    });

    return res.status(201).json({ success: true, booking });
  } catch (err) {
    console.error("SEAT TABLE WALK-IN error:", err);
    return res.status(500).json({ error: "Failed to seat table" });
  }
};

/* =====================================================
   MAINTENANCE TOGGLE
   PATCH /tables/:id/maintenance
   Body: { isMaintenance: boolean }
===================================================== */
exports.setTableMaintenance = async (req, res) => {
  try {
    const businessId = req.businessId;
    const tableId = req.params.id;

    const raw = req.body?.isMaintenance;

    if (raw === undefined) {
      return res.status(400).json({ error: "isMaintenance is required" });
    }

    const isMaintenance = Boolean(raw);

    const table = await Table.findOne({
      _id: tableId,
      businessId,
      isActive: true,
    });

    if (!table) {
      return res.status(404).json({ error: "Table not found" });
    }

    table.isMaintenance = isMaintenance;
    await table.save();

    return res.json({ success: true, table });
  } catch (err) {
    console.error("SET TABLE MAINTENANCE error:", err);
    return res.status(500).json({ error: "Failed to update maintenance" });
  }
};