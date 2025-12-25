// src/server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");

const connectDB = require("./config/db");

const webhookRoutes = require("./routes/webhookRoutes");
const authRoutes = require("./routes/authRoutes");
const callRoutes = require("./routes/callRoutes");
const agentRoutes = require("./routes/agentRoutes");
const agentMeRoutes = require("./routes/agentMeRoutes");
const businessRoutes = require("./routes/businessRoutes");
const adminAgentRoutes = require("./routes/adminAgentRoutes");

const app = express();

// =====================
// CORS
// =====================
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "https://ai-receptionist-frontend-xi.vercel.app",
];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked origin: ${origin}`), false);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// =====================
// BODY PARSER
// =====================
app.use(express.json({ limit: "10mb" }));

// =====================
// DB
// =====================
connectDB();

// =====================
// ROUTES
// =====================
app.get("/", (req, res) => res.send("AI Receptionist Backend is running"));

app.use("/", webhookRoutes);
app.use("/auth", authRoutes);
app.use("/calls", callRoutes);
app.use("/agents", agentRoutes);
app.use("/admin", adminAgentRoutes);
app.use("/business/agent", agentMeRoutes);
app.use("/business", businessRoutes);

// =====================
// ERROR HANDLER
// =====================
app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err);
  res.status(500).json({ error: err.message || "Server error" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});