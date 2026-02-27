const express = require("express");
const router = express.Router();
const { respond } = require("../controllers/llmController");

router.post("/respond", respond);

module.exports = router;