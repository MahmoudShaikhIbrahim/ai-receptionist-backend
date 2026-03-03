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

const { handleLLMWebSocket } = require("./ws/llmSocket"); // we will create this

const app = express();
const server = http.createServer(app);

// =====================
// CORS
// =====================
app.use(cors());
app.use(express.json({ limit: "10mb" }));

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
  console.log("🔌 Retell WebSocket connected");
  handleLLMWebSocket(ws);
});

// =====================
// START SERVER
// =====================
const PORT = process.env.PORT || 3000;

server.listen(PORT, () =>
  console.log(`🚀 Server + WebSocket running on port ${PORT}`)
);