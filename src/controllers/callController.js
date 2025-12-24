const Call = require("../models/Call");

exports.getBusinessCalls = async (req, res) => {
  const businessId = req.businessId;

  const {
    type = "all",
    page = 1,
    limit = 20,
  } = req.query;

  const safeLimit = Math.min(Number(limit) || 20, 100);
  const safePage = Math.max(Number(page) || 1, 1);
  const skip = (safePage - 1) * safeLimit;

  const filter = { businessId };

  if (type === "order") {
    filter.orderData = { $ne: null };
  }

  if (type === "booking") {
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

  res.json({
    data: calls,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      pages: Math.ceil(total / safeLimit),
    },
  });
};