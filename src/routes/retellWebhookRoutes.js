// src/routes/retellWebhookRoutes.js

const express = require("express");
const router = express.Router();
const { handleRetellWebhook } = require("../controllers/retellWebhookController");

/*
  Final endpoint:
  POST /webhooks/retell
*/

router.post(
  "/retell",
  express.json({ type: "*/*", limit: "2mb" }),
  handleRetellWebhook
);

module.exports = router;