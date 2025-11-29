const express = require("express");
const router = express.Router();
const { handleWebhook } = require("../controllers/webhookController");

// Retell will POST here
router.post("/retell/webhook", handleWebhook);

module.exports = router;