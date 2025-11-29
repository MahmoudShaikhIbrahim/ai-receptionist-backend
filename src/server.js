require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");

const connectDB = require("./config/db");
const webhookRoutes = require("./routes/webhookRoutes");
const callRoutes = require("./routes/callRoutes");

const app = express();

// =====================
// MIDDLEWARE
// =====================
app.use(cors());
app.use(express.json());
app.use(bodyParser.json());

// =====================
// CONNECT TO MONGO
// =====================
connectDB();

// =====================
// ROUTES
// =====================
app.use("/", webhookRoutes);
app.use("/calls", callRoutes);

// TEST ROUTE
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