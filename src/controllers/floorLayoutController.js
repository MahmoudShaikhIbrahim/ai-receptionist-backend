// src/controllers/floorLayoutController.js
const mongoose = require("mongoose");
const Floor = require("../models/Floor");
const Table = require("../models/Table");

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

/**
 * GET /floors/:floorId/layout
 * Returns floor + all active tables on that floor (for editor)
 */
exports.getFloorLayout = async (req, res) => {
  try {
    const businessId = req.businessId;
    const { floorId } = req.params;

    if (!isValidObjectId(floorId)) {
      return res.status(400).json({ error: "Invalid floorId" });
    }

    const floor = await Floor.findOne({
      _id: floorId,
      businessId,
      isActive: true,
    }).lean();

    if (!floor) {
      return res.status(404).json({ error: "Floor not found" });
    }

    const tables = await Table.find({
      businessId,
      floorId,
      isActive: true,
    })
      .sort({ label: 1 })
      .lean();

    return res.json({ floor, tables });
  } catch (err) {
    console.error("❌ getFloorLayout error:", err);
    return res.status(500).json({ error: "Failed to load floor layout" });
  }
};

/**
 * PUT /floors/:floorId/layout
 * Body:
 * {
 *   tables: [{ _id, x, y, w, h, floorId? }]
 * }
 *
 * - Bulk updates x/y/w/h
 * - Enforces ownership: businessId + floorId
 * - Clamps to floor bounds (optional safety)
 */
exports.saveFloorLayout = async (req, res) => {
  try {
    const businessId = req.businessId;
    const { floorId } = req.params;

    if (!isValidObjectId(floorId)) {
      return res.status(400).json({ error: "Invalid floorId" });
    }

    const floor = await Floor.findOne({
      _id: floorId,
      businessId,
      isActive: true,
    }).lean();

    if (!floor) {
      return res.status(404).json({ error: "Floor not found" });
    }

    const payload = req.body || {};
    const tables = Array.isArray(payload.tables) ? payload.tables : [];

    if (!tables.length) {
      return res.status(400).json({ error: "tables[] is required" });
    }

    // Fetch all tables on this floor for this business (active only)
    const existing = await Table.find({
      businessId,
      floorId,
      isActive: true,
    }).select("_id").lean();

    const allowedIds = new Set(existing.map((t) => String(t._id)));

    const ops = [];

    for (const t of tables) {
      const id = t?._id;
      if (!id || !isValidObjectId(id)) continue;
      if (!allowedIds.has(String(id))) continue;

      // Safe numeric conversion
      let x = Number(t.x);
      let y = Number(t.y);
      let w = Number(t.w);
      let h = Number(t.h);

      if (!Number.isFinite(x)) x = 0;
      if (!Number.isFinite(y)) y = 0;
      if (!Number.isFinite(w)) w = 80;
      if (!Number.isFinite(h)) h = 80;

      // Basic min constraints
      if (w < 20) w = 20;
      if (h < 20) h = 20;
      if (x < 0) x = 0;
      if (y < 0) y = 0;

      // Clamp inside floor canvas (so tables never go outside)
      const maxX = Math.max(0, Number(floor.width || 1200) - w);
      const maxY = Math.max(0, Number(floor.height || 800) - h);
      if (x > maxX) x = maxX;
      if (y > maxY) y = maxY;

      ops.push({
        updateOne: {
          filter: { _id: id, businessId, floorId, isActive: true },
          update: { $set: { x, y, w, h } },
        },
      });
    }

    if (!ops.length) {
      return res.status(400).json({ error: "No valid table updates provided" });
    }

    await Table.bulkWrite(ops, { ordered: false });

    // Return updated tables
    const updatedTables = await Table.find({
      businessId,
      floorId,
      isActive: true,
    })
      .sort({ label: 1 })
      .lean();

    return res.json({ success: true, floor, tables: updatedTables });
  } catch (err) {
    console.error("❌ saveFloorLayout error:", err);
    return res.status(500).json({ error: "Failed to save layout" });
  }
};