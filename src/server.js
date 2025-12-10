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

const app = express();
const server = http.createServer(app);

// Socket.io will be added here later for real-time
// const { setupWebSocket } = require("./services/websocket");
// setupWebSocket(server);

// =====================
// CORS FIX FOR RAILWAY + VERCEL
// =====================
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://ai-receptionist-frontend-xi.vercel.app",
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

// Old agent routes – keep for now as admin-only / testing
app.use("/agents", agentRoutes);

// New proper auth + business / dashboard API
app.use("/auth", authRoutes);
app.use("/business", businessRoutes);

// HEALTH CHECK
app.get("/", (req, res) => {
  res.send("AI Receptionist Backend is running...");
});

// =====================
// START SERVER
// =====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});