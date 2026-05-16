const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { OAuth2Client } = require("google-auth-library");
const User = require("../models/User");

const router = express.Router();

// ── Simple in-memory rate limiter (no extra dependency needed) ─────────────
// 10 auth attempts per IP per 15 minutes
const authAttempts = new Map();
const RATE_LIMIT   = 10;
const WINDOW_MS    = 15 * 60 * 1000;

const authRateLimit = (req, res, next) => {
  const ip  = req.ip || req.connection?.remoteAddress || "unknown";
  const now = Date.now();
  let record = authAttempts.get(ip);

  if (!record || now > record.resetAt) {
    record = { count: 0, resetAt: now + WINDOW_MS };
  }
  record.count++;
  authAttempts.set(ip, record);

  // Prune old entries periodically (every 500 requests)
  if (authAttempts.size > 500) {
    for (const [key, val] of authAttempts) {
      if (now > val.resetAt) authAttempts.delete(key);
    }
  }

  if (record.count > RATE_LIMIT) {
    const retryAfter = Math.ceil((record.resetAt - now) / 60000);
    return res.status(429).json({
      message: `Too many attempts. Please try again in ${retryAfter} minute${retryAfter !== 1 ? "s" : ""}.`
    });
  }
  next();
};

// Apply rate limiting to all auth routes
router.use(authRateLimit);

// ── Lazy-initialize Google OAuth client ───────────────────────────────────
let _googleClient = null;
const getGoogleClient = () => {
  if (!_googleClient) {
    _googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
  }
  return _googleClient;
};

const createToken = (user) => jwt.sign(
  { userId: user._id, role: user.role, email: user.email },
  process.env.JWT_SECRET || "carpool-dev-secret",
  { expiresIn: "7d" }
);

const ensureDatabaseConnected = (res) => {
  if (mongoose.connection.readyState !== 1) {
    res.status(503).json({
      message: "Database not connected. Please check MongoDB credentials in server/.env"
    });
    return false;
  }
  return true;
};

// ── POST /api/auth/register ────────────────────────────────────────────────
router.post("/register", async (req, res) => {
  if (!ensureDatabaseConnected(res)) return;

  const { name, email, mobileNumber, password, companyId, location, role, riderCredentials } = req.body;

  if (!name || !email || !mobileNumber || !password || !companyId || !location) {
    return res.status(400).json({
      message: "name, email, mobileNumber, password, companyId and location are required"
    });
  }

  if (password.length < 8) {
    return res.status(400).json({ message: "Password must be at least 8 characters" });
  }

  const normalizedMobile = String(mobileNumber).replace(/\D/g, "");
  if (!/^\d{10}$/.test(normalizedMobile)) {
    return res.status(400).json({ message: "mobileNumber must be exactly 10 digits" });
  }

  // FIX: "admin" removed — admin accounts must be created server-side only
  const normalizedRole = role || "traveler";
  if (!["traveler", "rider"].includes(normalizedRole)) {
    return res.status(400).json({ message: "role must be traveler or rider" });
  }

  if (normalizedRole === "rider") {
    const missingRiderData =
      !riderCredentials ||
      !riderCredentials.aadhaarNumber ||
      !riderCredentials.vehicleNumber ||
      !riderCredentials.vehicleModel ||
      !riderCredentials.drivingLicenseNumber;

    if (missingRiderData) {
      return res.status(400).json({
        message: "Rider registration requires aadhaarNumber, vehicleNumber, vehicleModel and drivingLicenseNumber"
      });
    }

    const aadhaar             = String(riderCredentials.aadhaarNumber).replace(/\s+/g, "");
    const vehicleNumber       = String(riderCredentials.vehicleNumber).toUpperCase().replace(/\s+/g, "");
    const drivingLicenseNumber = String(riderCredentials.drivingLicenseNumber).toUpperCase().replace(/\s+/g, "");

    if (!/^\d{12}$/.test(aadhaar)) {
      return res.status(400).json({ message: "Aadhaar number must be exactly 12 digits" });
    }
    if (!/^[A-Z]{2}\d{2}[A-Z]{1,2}\d{4}$/.test(vehicleNumber)) {
      return res.status(400).json({ message: "Vehicle number format is invalid (example: KA01AB1234)" });
    }
    if (!/^[A-Z0-9]{10,20}$/.test(drivingLicenseNumber)) {
      return res.status(400).json({ message: "Driving license number format is invalid" });
    }

    riderCredentials.aadhaarNumber        = aadhaar;
    riderCredentials.vehicleNumber        = vehicleNumber;
    riderCredentials.drivingLicenseNumber = drivingLicenseNumber;
  }

  try {
    const existingUser = await User.findOne({ email: email.toLowerCase() });
    if (existingUser) {
      return res.status(400).json({ message: "Email already registered" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      name,
      email: email.toLowerCase(),
      mobileNumber: normalizedMobile,
      password: hashedPassword,
      companyId,
      location,
      role: normalizedRole,
      riderCredentials: normalizedRole === "rider" ? riderCredentials : undefined
    });

    return res.status(201).json({
      message: "Registration successful",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        mobileNumber: user.mobileNumber,
        role: user.role
      }
    });
  } catch (error) {
    return res.status(500).json({ message: "Registration failed", error: error.message });
  }
});

// ── POST /api/auth/login ───────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  if (!ensureDatabaseConnected(res)) return;

  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: "email and password are required" });
  }

  try {
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = createToken(user);
    return res.json({
      message: "Login successful",
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        mobileNumber: user.mobileNumber || "",
        riderCredentials: user.riderCredentials || null
      }
    });
  } catch (error) {
    return res.status(500).json({ message: "Login failed", error: error.message });
  }
});

// ── POST /api/auth/google  (Google Sign-In via ID token) ──────────────────
router.post("/google", async (req, res) => {
  if (!ensureDatabaseConnected(res)) return;

  const { idToken } = req.body;
  if (!idToken) {
    return res.status(400).json({ message: "idToken is required" });
  }

  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.status(500).json({ message: "Google login is not configured" });
  }

  try {
    const ticket = await getGoogleClient().verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();
    const email   = payload?.email?.toLowerCase();

    if (!email || !payload?.email_verified) {
      return res.status(401).json({ message: "Google account email not verified" });
    }

    let user = await User.findOne({ email });

    // FIX: auto-create a traveler account when Google user isn't registered yet
    // Instead of a dead-end 404, we create the account and flag it as new
    // so the client can prompt for missing profile details.
    let isNewUser = false;
    if (!user) {
      const randomPassword = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
      user = await User.create({
        name:         payload.name || email.split("@")[0],
        email,
        mobileNumber: "0000000000",   // placeholder — user must update in profile
        password:     randomPassword,
        companyId:    "PENDING",      // placeholder
        location:     "Not set",      // placeholder
        role:         "traveler"
      });
      isNewUser = true;
    }

    const token = createToken(user);
    return res.status(isNewUser ? 201 : 200).json({
      message: isNewUser
        ? "Account created via Google. Please complete your profile."
        : "Login successful",
      isNewUser,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        mobileNumber: user.mobileNumber || "",
        riderCredentials: user.riderCredentials || null
      }
    });
  } catch (error) {
    return res.status(500).json({ message: "Google login failed", error: error.message });
  }
});

module.exports = router;
