const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");

const connectDB = require("./config/db");
const webhookRoutes = require("./routes/webhookRoutes");
const callRoutes = require("./routes/callRoutes");

const app = express();

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json());          // Correct JSON parser
app.use(bodyParser.json());       // (Optional but fine)

// ===== CONNECT TO MONGODB =====
connectDB();

// ===== ROUTES =====
// Webhook routes (Retell.ai)
app.use("/", webhookRoutes);

// Calls API route (frontend uses this!)
app.use("/calls", callRoutes);

// ===== TEST ROUTE =====
app.get("/", (req, res) => {
  res.send("AI Receptionist Backend is running...");
});

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});