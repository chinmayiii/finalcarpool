"use strict";

const express = require("express");
const http    = require("http");
const mongoose = require("mongoose");
const cors    = require("cors");
const jwt     = require("jsonwebtoken");
const { Server } = require("socket.io");
const path    = require("path");

require("dotenv").config({ path: path.join(__dirname, ".env") });

const Ride = require("./models/Ride");

// ── Startup guards ─────────────────────────────────────────────────────────
if (!process.env.MONGO_URI) {
  console.error("FATAL: MONGO_URI environment variable is required.");
  console.error("Set it to your MongoDB Atlas connection string.");
  process.exit(1);
}

if (!process.env.JWT_SECRET) {
  console.error("FATAL: JWT_SECRET environment variable is required.");
  process.exit(1);
}

// ── Express + HTTP server ──────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// Trust proxy headers — required for correct req.ip behind Railway/Vercel/nginx
app.set("trust proxy", 1);

const allowedOrigins = (process.env.CLIENT_ORIGIN || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Always allow same-origin; fall back gracefully when CLIENT_ORIGIN is unset
const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin) return callback(null, true);
    if (!allowedOrigins.length || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error(`CORS: origin '${origin}' not allowed`));
  },
  credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json());

// ── Socket.io ──────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: corsOptions,
  // Allow WebSocket transport first, then polling fallback
  transports: ["websocket", "polling"],
});

// Authenticate every socket connection with JWT
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error("Authentication required"));
  try {
    socket.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    next(new Error("Invalid or expired token"));
  }
});

io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id} (user: ${socket.user?.userId})`);

  // Only authorized driver/passenger may join a ride room
  socket.on("joinRide", async (rideId) => {
    try {
      const ride = await Ride.findById(rideId).select("driverId requests");
      if (!ride) return;

      const isDriver    = ride.driverId?.toString() === socket.user.userId;
      const isPassenger = ride.requests.some(
        (r) => r.status === "accepted" && r.travelerId?.toString() === socket.user.userId
      );

      if (isDriver || isPassenger) {
        socket.join(rideId);
      } else {
        socket.emit("error", { message: "Not authorized to join this ride room" });
      }
    } catch (err) {
      console.error("joinRide error:", err.message);
    }
  });

  socket.on("sendLocation", ({ rideId, lat, lng }) => {
    if (!rideId) return;
    io.to(rideId).emit("locationUpdate", { lat, lng });
  });

  socket.on("disconnect", () => {
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

// ── Static files (served when running full-stack on Railway) ───────────────
app.use(express.static(path.join(__dirname, "../client")));

// ── API routes ────────────────────────────────────────────────────────────
app.use("/api/auth",   require("./routes/authRoutes"));
app.use("/api/rides",  require("./routes/rideRoutes"));
app.use("/api/config", require("./routes/configRoutes"));

// Health-check (used by Railway and uptime monitors)
app.get("/health", (req, res) => {
  const dbState = mongoose.connection.readyState;
  const status  = dbState === 1 ? "ok" : "degraded";
  res.status(dbState === 1 ? 200 : 503).json({
    status,
    db: ["disconnected", "connected", "connecting", "disconnecting"][dbState] ?? "unknown",
    uptime: Math.floor(process.uptime()),
  });
});

// API 404 guard
app.use("/api", (req, res) => {
  res.status(404).json({ message: `API route not found: ${req.method} ${req.originalUrl}` });
});

// SPA fallback — must come AFTER all API routes
app.get("/{*path}", (req, res) => {
  res.sendFile(path.join(__dirname, "../client/index.html"));
});

// ── MongoDB Atlas connection with automatic retry ──────────────────────────
const MONGO_OPTS = {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS:          45000,
  // Connection pool — tune for Railway's free tier (256 MB RAM)
  maxPoolSize:  10,
  minPoolSize:  2,
};

const connectMongo = async (attempt = 1) => {
  const MAX_RETRIES = 5;
  try {
    await mongoose.connect(process.env.MONGO_URI, MONGO_OPTS);
    console.log("✅ MongoDB Atlas connected");
  } catch (err) {
    console.error(`❌ MongoDB connection attempt ${attempt} failed: ${err.message}`);
    if (attempt >= MAX_RETRIES) {
      console.error("FATAL: Could not connect to MongoDB Atlas after maximum retries.");
      process.exit(1);
    }
    const delay = Math.min(1000 * 2 ** attempt, 30000); // exponential back-off, max 30s
    console.log(`Retrying in ${delay / 1000}s...`);
    await new Promise((r) => setTimeout(r, delay));
    return connectMongo(attempt + 1);
  }
};

// Reconnect on unexpected disconnects
mongoose.connection.on("disconnected", () => {
  console.warn("MongoDB disconnected — reconnecting...");
  connectMongo().catch(() => {}); // let retry logic handle it
});

mongoose.connection.on("error", (err) => {
  console.error("MongoDB error:", err.message);
});

// ── Boot ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8000;

connectMongo().then(() => {
  server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`   NODE_ENV:     ${process.env.NODE_ENV || "development"}`);
    console.log(`   CLIENT_ORIGIN: ${process.env.CLIENT_ORIGIN || "(same-origin)"}`);
  });
});
