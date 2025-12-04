const express = require("express");
const router = express.Router();
const { handleWebhook } = require("../controllers/webhookController");

// Retell sends raw body for webhooks — required for proper signature validation later
router.post(
  "/retell/webhook",
  express.json({ type: "*/*" }),
  handleWebhook
);

module.exports = router;