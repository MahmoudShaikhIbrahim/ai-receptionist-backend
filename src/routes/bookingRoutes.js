// src/routes/bookingRoutes.js

const express = require("express");
const router = express.Router();

const requireAuth = require("../middleware/authMiddleware");
const {
  listBookings,
  createBookingAI,
  createBookingManual,
  updateBookingStatus,
  getLiveTableStatus,
} = require("../controllers/bookingController");

/* =====================================================
   AI BOOKING (Called by Retell Custom LLM Tool)
   Public endpoint but must validate payload internally
===================================================== */
router.post(
  "/ai",
  express.json({ limit: "2mb" }),
  async (req, res, next) => {
    try {
      if (!req.body || !req.body.businessId) {
        return res.status(400).json({ error: "Missing businessId" });
      }
      next();
    } catch (err) {
      return res.status(400).json({ error: "Invalid payload" });
    }
  },
  createBookingAI
);

/* =====================================================
   DASHBOARD BOOKINGS (AUTH)
===================================================== */

// List
router.get("/", requireAuth, listBookings);

// Manual booking from dashboard UI
router.post("/manual", requireAuth, createBookingManual);
router.patch("/:id/status", requireAuth, updateBookingStatus);
router.get("/tables/live", requireAuth, getLiveTableStatus);

module.exports = router;