// src/routes/floorRoutes.js

const express = require("express");
const mongoose = require("mongoose");
const upload = require("../middleware/uploadMiddleware");
const router = express.Router();
const requireAuth = require("../middleware/authMiddleware");
const Floor = require("../models/Floor");

const { getLiveFloor } = require("../controllers/floorController");
const {
  getFloorLayout,
  saveFloorLayout,
  removeLayoutImage,
} = require("../controllers/floorLayoutController");


/* =====================================================
   CREATE FLOOR
===================================================== */
router.post("/", requireAuth, async (req, res) => {
  try {
    const { name, width, height } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Floor name required" });
    }

    const floor = await Floor.create({
      businessId: req.businessId,
      name: String(name).trim(),
      width: width ?? 1200,
      height: height ?? 800,
    });

    return res.status(201).json({ floor });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ error: "Floor name already exists" });
    }

    console.error("CREATE FLOOR error:", err);
    return res.status(500).json({ error: "Failed to create floor" });
  }
});

/* =====================================================
   GET ALL FLOORS
===================================================== */
router.get("/", requireAuth, async (req, res) => {
  try {
    const floors = await Floor.find({
      businessId: req.businessId,
      isActive: true,
    }).sort({ createdAt: 1 });

    return res.json({ floors });
  } catch (err) {
    console.error("GET FLOORS error:", err);
    return res.status(500).json({ error: "Failed to fetch floors" });
  }
});

/* =====================================================
   FLOOR LAYOUT IMAGE UPLOAD
   POST /floors/:floorId/layout-image
===================================================== */
router.post(
  "/:floorId/layout-image",
  requireAuth,
  upload.single("image"),
  async (req, res) => {
    try {
      const floor = await Floor.findOne({
        _id: req.params.floorId,
        businessId: req.businessId,
      });

      if (!floor) {
        return res.status(404).json({ error: "Floor not found" });
      }

      if (!req.file) {
        return res.status(400).json({ error: "No image uploaded" });
      }

      floor.layoutImageUrl = `/uploads/${req.file.filename}`;
      await floor.save();

      return res.json({ floor });

    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Upload failed" });
    }
  }
);

/* =====================================================
   SERVE FLOOR LAYOUT IMAGE
   GET /floors/:floorId/layout-image
===================================================== */
router.get("/:floorId/layout-image", requireAuth, async (req, res) => {
  try {
    const floor = await Floor.findOne({
      _id: req.params.floorId,
      businessId: req.businessId,
    });

    if (!floor || !floor.layoutImage?.fileId) {
      return res.status(404).json({ error: "No layout image found" });
    }

    res.set("Content-Type", floor.layoutImage.contentType);

    const downloadStream = gfs.openDownloadStream(
      floor.layoutImage.fileId
    );

    downloadStream.pipe(res);
  } catch (err) {
    console.error("GET LAYOUT IMAGE error:", err);
    return res.status(500).json({ error: "Failed to fetch layout image" });
  }
});

/* =====================================================
   FLOOR LAYOUT (EDITOR)
===================================================== */
router.get("/:floorId/layout", requireAuth, getFloorLayout);
router.delete("/:floorId/layout-image", requireAuth, removeLayoutImage);

router.put(
  "/:floorId/layout",
  requireAuth,
  express.json({ limit: "2mb" }),
  saveFloorLayout
);

/* =====================================================
   LIVE FLOOR (MONITOR)
===================================================== */
router.get("/:floorId/live", requireAuth, getLiveFloor);

/* =====================================================
   UPDATE FLOOR
===================================================== */
router.put("/:id", requireAuth, async (req, res) => {
  try {
    const floor = await Floor.findOne({
      _id: req.params.id,
      businessId: req.businessId,
    });

    if (!floor) {
      return res.status(404).json({ error: "Floor not found" });
    }

    const allowed = ["name", "width", "height", "isActive"];

    allowed.forEach((key) => {
      if (req.body[key] !== undefined) {
        floor[key] = req.body[key];
      }
    });

    await floor.save();

    return res.json({ floor });
  } catch (err) {
    console.error("UPDATE FLOOR error:", err);
    return res.status(500).json({ error: "Failed to update floor" });
  }
});

/* =====================================================
   DELETE FLOOR (Soft delete)
===================================================== */
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const floor = await Floor.findOne({
      _id: req.params.id,
      businessId: req.businessId,
    });

    if (!floor) {
      return res.status(404).json({ error: "Floor not found" });
    }

    floor.isActive = false;
    await floor.save();

    return res.json({ success: true });
  } catch (err) {
    console.error("DELETE FLOOR error:", err);
    return res.status(500).json({ error: "Failed to delete floor" });
  }
});

router.post(
  "/:floorId/layout-image",
  requireAuth,
  upload.single("image"),
  async (req, res) => {
    try {
      const floor = await Floor.findOne({
        _id: req.params.floorId,
        businessId: req.businessId,
      });

      if (!floor) {
        return res.status(404).json({ error: "Floor not found" });
      }

      if (!req.file) {
        return res.status(400).json({ error: "No image uploaded" });
      }

      floor.layoutImageUrl = `/uploads/${req.file.filename}`;
      await floor.save();

      return res.json({ floor });
    } catch (err) {
      console.error("UPLOAD LAYOUT IMAGE error:", err);
      return res.status(500).json({ error: "Upload failed" });
    }
  }
);

module.exports = router;