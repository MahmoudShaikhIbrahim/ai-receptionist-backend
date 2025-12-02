require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");

const connectDB = require("./config/db");
const webhookRoutes = require("./routes/webhookRoutes");
const callRoutes = require("./routes/callRoutes");

const app = express();

// =====================
// FIXED CORS
// =====================
app.use(
  cors({
    origin: "*", // Allow all origins (Netlify, Render, localhost)
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// =====================
// BODY PARSERS
// =====================
app.use(express.json({ limit: "10mb" }));
app.use(bodyParser.json());

// =====================
// CONNECT TO DATABASE
// =====================
connectDB();

// =====================
// ROUTES
// =====================
app.use("/", webhookRoutes);
app.use("/calls", callRoutes);

// HEALTH CHECK
app.get("/", (req, res) => {
  res.send("AI Receptionist Backend is running...");
});

// =====================
// START SERVER
// =====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});