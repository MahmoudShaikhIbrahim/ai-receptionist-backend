// src/server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");

const connectDB = require("./config/db");

// Routes
const webhookRoutes = require("./routes/webhookRoutes");
const authRoutes = require("./routes/authRoutes");
const callRoutes = require("./routes/callRoutes");
const agentRoutes = require("./routes/agentRoutes");
const agentMeRoutes = require("./routes/agentMeRoutes");
const businessRoutes = require("./routes/businessRoutes");
const adminAgentRoutes = require("./routes/adminAgentRoutes");

const app = express();

/* =====================
   CORS
===================== */
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "https://ai-receptionist-frontend-xi.vercel.app",
];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // server-to-server / Postman
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS blocked origin: ${origin}`), false);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 204,
  })
);

/* =====================
   BODY PARSER
===================== */
app.use(express.json({ limit: "10mb" }));

/* =====================
   DATABASE
===================== */
connectDB();

/* =====================
   HEALTH CHECK
===================== */
app.get("/", (_req, res) => {
  res.send("AI Receptionist Backend is running...");
});

/* =====================
   ROUTES
===================== */

// 🔔 Retell webhook (POST /retell/webhook)
app.use("/", webhookRoutes);

// 🔐 Auth
app.use("/auth", authRoutes);

// 🧠 Admin
app.use("/admin", adminAgentRoutes);

// 🏢 Business-scoped APIs
app.use("/business/agent", agentMeRoutes);
app.use("/business/calls", callRoutes);
app.use("/business", businessRoutes);

// 👨‍💼 Agent admin (internal / admin usage)
app.use("/agents", agentRoutes);

/* =====================
   GLOBAL ERROR HANDLER
===================== */
app.use((err, req, res, _next) => {
  console.error("SERVER ERROR:", err);
  res.status(500).json({ error: err.message || "Server error" });
});

/* =====================
   START SERVER
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});