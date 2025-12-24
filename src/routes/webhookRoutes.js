// src/routes/webhookRoutes.js
const express = require("express");
const router = express.Router();
const { handleWebhook } = require("../controllers/webhookController");

// Keep BOTH endpoints to avoid breaking Retell settings
router.post(
  ["/retell/webhook", "/retell"],
  express.json({ type: "*/*", limit: "2mb" }),
  handleWebhook
);

module.exports = router;