// src/server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");

const connectDB = require("./config/db");

const retellWebhookRoutes = require("./routes/retellWebhookRoutes");
const llmRoutes = require("./routes/llmRoutes");
const authRoutes = require("./routes/authRoutes");
const callRoutes = require("./routes/callRoutes");
const businessRoutes = require("./routes/businessRoutes");
const bookingRoutes = require("./routes/bookingRoutes");
const floorRoutes = require("./routes/floorRoutes");
const tableRoutes = require("./routes/tableRoutes");
const path = require("path");

const { handleLLMWebSocket } = require("./ws/llmSocket");

const app = express();
const server = http.createServer(app);

// =====================
// CORS & Body Parsing
// =====================
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Connect to MongoDB
connectDB();

// =====================
// ROUTES
// =====================
app.get("/", (req, res) => res.send("AI Receptionist Backend Running"));

app.use("/webhooks", retellWebhookRoutes);
app.use("/llm", llmRoutes);
app.use("/auth", authRoutes);
app.use("/calls", callRoutes);
app.use("/business", businessRoutes);
app.use("/bookings", bookingRoutes);
app.use("/floors", floorRoutes);
app.use("/tables", tableRoutes);
app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

// =====================
// WEBSOCKET SERVER
// =====================
const wss = new WebSocket.Server({ server, path: "/llm/respond" });

wss.on("connection", (ws, req) => {
  // Log connection details for debugging
  const clientIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  console.log(`🔌 New WebSocket connection from ${clientIp} to path: ${req.url}`);

  // Optional: You could add authorization or reject invalid connections here later

  // Pass both ws and req to the handler (req useful for path/call_id in future)
  handleLLMWebSocket(ws, req);
});

wss.on("error", (error) => {
  console.error("WebSocket server error:", error);
});

// =====================
// START SERVER
// =====================
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`WebSocket listening at wss://your-domain.up.railway.app/llm/respond`);
  console.log("Ready for Retell Custom LLM connections");
});