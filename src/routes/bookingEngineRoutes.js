const express = require("express");
const router = express.Router();

const { createAIBooking } = require("../controllers/bookingEngineController");

router.post("/ai", createAIBooking);

module.exports = router;