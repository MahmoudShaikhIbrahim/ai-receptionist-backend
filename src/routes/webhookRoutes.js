const express = require("express");
const router = express.Router();
const { handleWebhook } = require("../controllers/webhookController");

// Accept BOTH paths safely
router.post(
  ["/retell", "/retell/webhook"],
  express.json({ type: "*/*" }),
  handleWebhook
);

module.exports = router;