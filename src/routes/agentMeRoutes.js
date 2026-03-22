const express = require("express");
const router = express.Router();
const requireAuth = require("../middleware/authMiddleware");
const agentController = require("../controllers/agentController");

// GET agent settings
router.get("/me", requireAuth, agentController.getMe);
router.get("/", requireAuth, agentController.getMe);

// UPDATE agent personality + prompt
router.put("/", requireAuth, agentController.updateAgent);

// UPDATE features
router.put("/features", requireAuth, agentController.updateFeatures);

// UPDATE opening hours
router.put("/hours", requireAuth, agentController.updateOpeningHours);

// MENU
router.post("/menu", requireAuth, agentController.addMenuItem);
router.put("/menu/:itemId", requireAuth, agentController.updateMenuItem);
router.delete("/menu/:itemId", requireAuth, agentController.deleteMenuItem);

module.exports = router;