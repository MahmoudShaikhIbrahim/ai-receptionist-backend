const Call = require("../models/Call");

/**
 * GET /calls
 * Query params:
 *  - type: all | order | booking
 *  - page: number (default 1)
 *  - limit: number (default 20, max 100)
 */
exports.getBusinessCalls = async (req, res) => {
  try {
    // businessId is injected by auth middleware
    const businessId = req.businessId;

    if (!businessId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { type = "all", page = 1, limit = 20 } = req.query;

    const safeLimit = Math.min(Number(limit) || 20, 100);
    const safePage = Math.max(Number(page) || 1, 1);
    const skip = (safePage - 1) * safeLimit;

    const filter = { businessId };

    // Filter by call type
    if (type === "order") {
      filter.orderData = { $ne: null };
    } else if (type === "booking") {
      filter.bookingData = { $ne: null };
    }

    const [calls, total] = await Promise.all([
      Call.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(safeLimit)
        .lean(),

      Call.countDocuments(filter),
    ]);

    return res.json({
      data: calls,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        pages: Math.ceil(total / safeLimit),
      },
    });
  } catch (err) {
    console.error("❌ getBusinessCalls error:", err);
    return res.status(500).json({ error: "Failed to fetch calls" });
  }
};