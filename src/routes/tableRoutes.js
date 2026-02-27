// src/routes/tableRoutes.js

const express = require("express");
const router = express.Router();
const requireAuth = require("../middleware/authMiddleware");
const tableController = require("../controllers/tableController");

router.post("/", requireAuth, tableController.createTable);
router.get("/", requireAuth, tableController.getTables);

router.post("/:id/seat", requireAuth, express.json(), tableController.seatTableWalkIn);
router.patch("/:id/maintenance", requireAuth, express.json(), tableController.setTableMaintenance);

router.delete("/:id", requireAuth, tableController.deleteTable);
router.put("/:id", requireAuth, tableController.updateTable);
router.delete("/:id/hard", requireAuth, tableController.hardDeleteTable);
router.patch("/:id/restore", requireAuth, tableController.restoreTable);

module.exports = router;