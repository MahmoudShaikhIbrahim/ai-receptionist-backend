const mongoose = require("mongoose");

async function connectDB() {
  try {
    const uri = process.env.MONGO_URI;

    if (!uri) {
      throw new Error("❌ MONGO_URI is missing from environment variables!");
    }

    await mongoose.connect(uri, {
      dbName: "ai-receptionist-db", // 🔒 FORCE correct database
    });

    console.log("✅ MongoDB connected to ai-receptionist-db");
  } catch (error) {
    console.error("❌ MongoDB Connection Error:", error.message);
    process.exit(1);
  }
}

module.exports = connectDB;