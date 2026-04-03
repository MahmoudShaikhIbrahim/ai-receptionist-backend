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
const orderRoutes = require("./routes/orderRoutes");


const { handleLLMWebSocket } = require("./ws/llmSocket");

const app = express();
const server = http.createServer(app);

// =====================
// CORS & Body Parsing
// =====================
app.use(cors());
app.use(express.json({ limit: "10mb" }));

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
app.use("/orders", orderRoutes);
app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

// =====================
// WEBSOCKET SERVER
// =====================
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws, req) => {
  const url = req.url || "";

  const validPath =
    url.startsWith("/llm/respond") ||
    url.startsWith("/llm/call_") ||
    url.startsWith("/llm/");

  if (!validPath) {
    console.log("❌ Invalid WebSocket path:", url);
    ws.close();
    return;
  }

  const clientIp =
    req.headers["x-forwarded-for"] ||
    req.socket.remoteAddress ||
    "unknown";

  console.log(`🔌 Retell WebSocket connected from ${clientIp}`);
  console.log(`Path: ${url}`);

  handleLLMWebSocket(ws, req);
});

wss.on("error", (error) => {
  console.error("WebSocket server error:", error);
});

// =====================
// START SERVER (FIXED)
// =====================
const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    // 🔥 CRITICAL: WAIT for MongoDB before starting anything
    await connectDB();

    server.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(
        `WebSocket listening at wss://your-domain.up.railway.app/llm/respond`
      );
      console.log("Ready for Retell Custom LLM connections");
    });
  } catch (err) {
    console.error("❌ Failed to start server:", err.message);
    process.exit(1);
  }
}

startServer();