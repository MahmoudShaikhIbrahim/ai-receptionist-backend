const mongoose = require("mongoose");

async function connectDB() {
  try {
    console.log("🔗 Connecting to MongoDB...");

    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 5000, // fail fast if cannot connect
      socketTimeoutMS: 45000,        // keep socket alive
      maxPoolSize: 5,                // 🔥 limit connections (VERY IMPORTANT)
    });

    console.log("✅ MongoDB connected");

    // =========================
    // Runtime connection events
    // =========================
    mongoose.connection.on("error", (err) => {
      console.error("❌ MongoDB runtime error:", err.message);
    });

    mongoose.connection.on("disconnected", () => {
      console.warn("⚠️ MongoDB disconnected");
    });

    mongoose.connection.on("reconnected", () => {
      console.log("🔄 MongoDB reconnected");
    });

  } catch (err) {
    console.error("❌ MongoDB connection error:", err.message);

    // 🔥 CRITICAL: stop app if DB fails
    throw err;
  }
}

module.exports = connectDB;