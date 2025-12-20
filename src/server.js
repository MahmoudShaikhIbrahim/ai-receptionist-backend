// src/server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const http = require("http");

const connectDB = require("./config/db");
const webhookRoutes = require("./routes/webhookRoutes");
const agentRoutes = require("./routes/agentRoutes");
const callRoutes = require("./routes/callRoutes");
const authRoutes = require("./routes/authRoutes");
const businessRoutes = require("./routes/businessRoutes");
const agentMeRoutes = require("./routes/agentMeRoutes");

const app = express();
const server = http.createServer(app);

// =====================
// CORS (FIXED)
// =====================
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "https://ai-receptionist-frontend-xi.vercel.app",
];

const corsOptions = {
  origin: (origin, cb) => {
    // allow server-to-server / Postman / curl (no origin)
    if (!origin) return cb(null, true);

    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);

    return cb(new Error(`CORS blocked origin: ${origin}`), false);
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // IMPORTANT: preflight

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
// Put health check FIRST so it never gets shadowed
app.get("/", (req, res) => {
  res.send("AI Receptionist Backend is running...");
});

// Don’t mount webhooks at "/" (too broad). Give it a path.
app.use("/", webhookRoutes);

app.use("/calls", callRoutes);
app.use("/agents", agentRoutes);
app.use("/auth", authRoutes);
app.use("/business", businessRoutes);
app.use("/business/agent", agentMeRoutes);
// =====================
// ERROR HANDLER (so you see real CORS errors)
// =====================
app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err);
  res.status(500).json({ error: err.message || "Server error" });
});

// =====================
// START SERVER
// =====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});