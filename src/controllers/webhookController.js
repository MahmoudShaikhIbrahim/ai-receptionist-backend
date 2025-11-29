exports.handleWebhook = async (req, res) => {
  console.log("🔥 Retell Webhook Event Received:");
  console.log(JSON.stringify(req.body, null, 2));

  // Always respond quickly so Retell doesn’t retry
  res.status(200).json({ received: true });
};