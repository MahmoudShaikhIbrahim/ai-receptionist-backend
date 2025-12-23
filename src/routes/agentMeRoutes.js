const express = require("express");
const router = express.Router();

const requireAuth = require("../middleware/authMiddleware");
const agentController = require("../controllers/agentController");

// ==========================
// GET CURRENT AGENT (ALIAS)
// GET /business/agent/me
// ==========================
router.get("/me", requireAuth, agentController.getMe);

// ==========================
// GET CURRENT AGENT
// GET /business/agent
// ==========================
router.get("/", requireAuth, agentController.getMe);

// ==========================
// UPDATE AGENT (CHANGE REQUEST)
// PUT /business/agent
// ==========================
router.put("/", requireAuth, agentController.updateAgent);

// ==========================
// UPDATE OPENING HOURS
// PUT /business/agent/hours
// ==========================
router.put("/hours", requireAuth, agentController.updateOpeningHours);

module.exports = router;