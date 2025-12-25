const express = require("express");
const router = express.Router();

const requireAuth = require("../middleware/authMiddleware");
const { getBusinessCalls } = require("../controllers/callController");

router.get("/", requireAuth, getBusinessCalls);

module.exports = router;