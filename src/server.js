require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");

const connectDB = require("./config/db");
const webhookRoutes = require("./routes/webhookRoutes");
const callRoutes = require("./routes/callRoutes");

const app = express();

// =====================
// CORS FIX FOR RAILWAY + VERCEL
// =====================
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://ai-receptionist-frontend-xi.vercel.app",
      "https://ai-receptionist-frontend-2cyj0sg9.vercel.app"
    ],
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