const express = require("express");
const { authenticateToken } = require("../middleware/auth");
const router = express.Router();

// Google Maps API key is sensitive — require a valid JWT before returning it
router.get("/maps-key", authenticateToken, (req, res) => {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY || "";
  res.json({ apiKey });
});

// Google Client ID is safe to expose (it is public by design)
router.get("/google-client-id", (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID || "";
  res.json({ clientId });
});

module.exports = router;
