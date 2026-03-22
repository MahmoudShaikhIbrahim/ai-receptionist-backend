// src/controllers/agentController.js
const Agent = require("../models/Agent");

/* ======================
   GET AGENT
====================== */
exports.getMe = async (req, res) => {
  try {
    const agent = await Agent.findOne({ businessId: req.businessId });
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.json({ agent });
  } catch (err) {
    res.status(500).json({ error: "Failed to load agent" });
  }
};

/* ======================
   UPDATE AGENT PERSONALITY
   PUT /business/agent
====================== */
exports.updateAgent = async (req, res) => {
  try {
    const agent = await Agent.findOne({ businessId: req.businessId });
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    const { agentName, agentPrompt, language, changeRequestText } = req.body;

    if (agentName !== undefined) agent.agentName = agentName;
    if (agentPrompt !== undefined) agent.agentPrompt = agentPrompt;
    if (language !== undefined) agent.language = language;
    if (changeRequestText !== undefined) {
      agent.changeRequestText = changeRequestText;
      agent.changeRequestStatus = "pending";
      agent.changeRequestUpdatedAt = new Date();
    }

    await agent.save();
    res.json({ message: "Agent updated", agent });
  } catch (err) {
    res.status(500).json({ error: "Failed to update agent" });
  }
};

/* ======================
   UPDATE FEATURES
   PUT /business/agent/features
====================== */
exports.updateFeatures = async (req, res) => {
  try {
    const agent = await Agent.findOne({ businessId: req.businessId });
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    const { bookings, orders, delivery, pickup, dineIn } = req.body;

    if (bookings !== undefined) agent.features.bookings = bookings;
    if (orders !== undefined) agent.features.orders = orders;
    if (delivery !== undefined) agent.features.delivery = delivery;
    if (pickup !== undefined) agent.features.pickup = pickup;
    if (dineIn !== undefined) agent.features.dineIn = dineIn;

    await agent.save();
    res.json({ message: "Features updated", features: agent.features });
  } catch (err) {
    res.status(500).json({ error: "Failed to update features" });
  }
};

/* ======================
   UPDATE OPENING HOURS
   PUT /business/agent/hours
====================== */
exports.updateOpeningHours = async (req, res) => {
  try {
    const agent = await Agent.findOne({ businessId: req.businessId });
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    agent.openingHours = req.body;
    await agent.save();
    res.json({ message: "Opening hours updated", openingHours: agent.openingHours });
  } catch (err) {
    res.status(500).json({ error: "Failed to update opening hours" });
  }
};

/* ======================
   ADD MENU ITEM
   POST /business/agent/menu
====================== */
exports.addMenuItem = async (req, res) => {
  try {
    const agent = await Agent.findOne({ businessId: req.businessId });
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    const { category, name, description, price, currency, available, extras } = req.body;

    if (!name || price === undefined) {
      return res.status(400).json({ error: "name and price are required" });
    }

    agent.menu.push({ category, name, description, price, currency, available, extras });
    await agent.save();

    const newItem = agent.menu[agent.menu.length - 1];
    res.status(201).json({ message: "Menu item added", item: newItem });
  } catch (err) {
    res.status(500).json({ error: "Failed to add menu item" });
  }
};

/* ======================
   UPDATE MENU ITEM
   PUT /business/agent/menu/:itemId
====================== */
exports.updateMenuItem = async (req, res) => {
  try {
    const agent = await Agent.findOne({ businessId: req.businessId });
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    const item = agent.menu.id(req.params.itemId);
    if (!item) return res.status(404).json({ error: "Menu item not found" });

    const { category, name, description, price, currency, available, extras } = req.body;

    if (category !== undefined) item.category = category;
    if (name !== undefined) item.name = name;
    if (description !== undefined) item.description = description;
    if (price !== undefined) item.price = price;
    if (currency !== undefined) item.currency = currency;
    if (available !== undefined) item.available = available;
    if (extras !== undefined) item.extras = extras;

    await agent.save();
    res.json({ message: "Menu item updated", item });
  } catch (err) {
    res.status(500).json({ error: "Failed to update menu item" });
  }
};

/* ======================
   DELETE MENU ITEM
   DELETE /business/agent/menu/:itemId
====================== */
exports.deleteMenuItem = async (req, res) => {
  try {
    const agent = await Agent.findOne({ businessId: req.businessId });
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    const item = agent.menu.id(req.params.itemId);
    if (!item) return res.status(404).json({ error: "Menu item not found" });

    item.deleteOne();
    await agent.save();
    res.json({ message: "Menu item deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete menu item" });
  }
};