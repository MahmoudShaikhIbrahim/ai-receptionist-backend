// src/routes/webhookRoutes.js
const express = require("express");
const router = express.Router();
const { handleWebhook } = require("../controllers/webhookController");

/**
 * Retell Webhook
 * Receives call events
 */
router.post(
  "/retell",
  express.json({ type: "*/*" }),
  handleWebhook
);

module.exports = router;