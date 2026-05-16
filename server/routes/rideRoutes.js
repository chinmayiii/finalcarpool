const express = require("express");
const mongoose = require("mongoose");
const Ride = require("../models/Ride");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();

// All ride routes require a valid JWT token
router.use(authenticateToken);

// ── Helpers ───────────────────────────────────────────────────────────────

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isValidObjectId = (id) =>
  mongoose.Types.ObjectId.isValid(id) && String(id).length === 24;

const toRadians = (deg) => (deg * Math.PI) / 180;

const haversineMeters = (a, b) => {
  const R = 6371000;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

const minDistanceToPathMeters = (point, pathCoords) => {
  if (!Array.isArray(pathCoords) || !pathCoords.length) return Infinity;
  let min = Infinity;
  for (const coord of pathCoords) {
    if (!Array.isArray(coord) || coord.length < 2) continue;
    const [lng, lat] = coord;
    if (typeof lat !== "number" || typeof lng !== "number") continue;
    const dist = haversineMeters(point, { lat, lng });
    if (dist < min) min = dist;
    if (min <= 1) break;
  }
  return min;
};

// ── GET /api/rides  (search — with pagination) ────────────────────────────
router.get("/", async (req, res) => {
  const { source, destination } = req.query;

  // FIX: pagination — default page 1, limit 20
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const skip  = (page - 1) * limit;

  const filter = {};
  if (source)      filter.source      = { $regex: escapeRegex(source),      $options: "i" };
  if (destination) filter.destination = { $regex: escapeRegex(destination), $options: "i" };

  try {
    const [rides, total] = await Promise.all([
      Ride.find(filter).sort({ _id: -1 }).skip(skip).limit(limit),
      Ride.countDocuments(filter)
    ]);
    res.json({
      rides,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch rides" });
  }
});

// ── GET /api/rides/match (route overlap by geo distance) ─────────────────
router.get("/match", async (req, res) => {
  const { srcLat, srcLng, dstLat, dstLng, maxDistance } = req.query;

  if ([srcLat, srcLng, dstLat, dstLng].some((v) => v === undefined)) {
    return res.status(400).json({ message: "srcLat, srcLng, dstLat, dstLng are required" });
  }

  const source      = { lat: Number(srcLat), lng: Number(srcLng) };
  const destination = { lat: Number(dstLat), lng: Number(dstLng) };
  const threshold   = maxDistance ? Number(maxDistance) : 1000;

  if (
    Number.isNaN(source.lat) || Number.isNaN(source.lng) ||
    Number.isNaN(destination.lat) || Number.isNaN(destination.lng) ||
    Number.isNaN(threshold)
  ) {
    return res.status(400).json({ message: "Coordinates and maxDistance must be numbers" });
  }

  try {
    const rides = await Ride.find({
      routePath: { $exists: true },
      seatsAvailable: { $gt: 0 }
    }).sort({ _id: -1 });

    const matched = rides.filter((ride) => {
      const path = ride.routePath?.coordinates;
      const srcDist = minDistanceToPathMeters(source, path);
      if (srcDist > threshold) return false;
      return minDistanceToPathMeters(destination, path) <= threshold;
    });

    return res.json(matched);
  } catch (error) {
    return res.status(500).json({ message: "Failed to match rides", error: error.message });
  }
});

// ── GET /api/rides/nearby ─────────────────────────────────────────────────
router.get("/nearby", async (req, res) => {
  const { lng, lat, maxDistance } = req.query;

  if (lng === undefined || lat === undefined) {
    return res.status(400).json({ message: "lng and lat query params are required" });
  }

  const userLng  = Number(lng);
  const userLat  = Number(lat);
  const distance = maxDistance ? Number(maxDistance) : 5000;

  if (Number.isNaN(userLng) || Number.isNaN(userLat) || Number.isNaN(distance)) {
    return res.status(400).json({ message: "lng, lat and maxDistance must be valid numbers" });
  }

  try {
    const rides = await Ride.find({
      sourceLocation: {
        $near: {
          $geometry: { type: "Point", coordinates: [userLng, userLat] },
          $maxDistance: distance
        }
      }
    });
    return res.json(rides);
  } catch (error) {
    return res.status(500).json({ message: "Failed to find nearby rides", error: error.message });
  }
});

// ── GET /api/rides/:id/requests ───────────────────────────────────────────
router.get("/:id/requests", async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    return res.status(400).json({ message: "Invalid ride ID format" });
  }
  try {
    const ride = await Ride.findById(req.params.id)
      .select("requests source destination driverId");
    if (!ride) return res.status(404).json({ message: "Ride not found" });

    const isDriver   = ride.driverId && ride.driverId.toString() === req.user.userId;
    const isAdmin    = req.user.role === "admin";
    const isTraveler = req.user.role === "traveler";

    if (!isDriver && !isAdmin && !isTraveler) {
      return res.status(403).json({ message: "Access denied" });
    }

    // FIX: traveler lookup uses authoritative travelerId from JWT, not email
    let requests = ride.requests;
    if (isTraveler && !isDriver && !isAdmin) {
      requests = ride.requests.filter(
        (r) => r.travelerId?.toString() === req.user.userId
      );
    }

    return res.json({
      rideId: req.params.id,
      source: ride.source,
      destination: ride.destination,
      requests
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch requests" });
  }
});

// ── GET /api/rides/:id  (single ride) ────────────────────────────────────
router.get("/:id", async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    return res.status(400).json({ message: "Invalid ride ID format" });
  }
  try {
    const ride = await Ride.findById(req.params.id);
    if (!ride) return res.status(404).json({ message: "Ride not found" });

    const isDriver = ride.driverId && ride.driverId.toString() === req.user.userId;
    const isAdmin  = req.user.role === "admin";
    if (isDriver || isAdmin) return res.json(ride);

    // FIX: use travelerId for lookup, not email
    const myRequest = ride.requests.find(
      (r) => r.travelerId?.toString() === req.user.userId
    );
    return res.json({
      _id: ride._id, source: ride.source, destination: ride.destination,
      riderName: ride.riderName, riderMobile: ride.riderMobile,
      vehicleDetails: ride.vehicleDetails, seatsAvailable: ride.seatsAvailable,
      time: ride.time, averageRating: ride.averageRating,
      myRequest: myRequest || null
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch ride", error: error.message });
  }
});

// ── POST /api/rides  (create a ride — rider only) ─────────────────────────
router.post("/", async (req, res) => {
  if (req.user.role !== "rider") {
    return res.status(403).json({ message: "Only riders can create rides" });
  }

  try {
    // FIX: prevent duplicate rides — same driver, same route, within ±30 min window
    const rideTime  = req.body.time ? new Date(req.body.time) : new Date();
    const windowMs  = 30 * 60 * 1000;
    const existing  = await Ride.findOne({
      driverId:    req.user.userId,
      source:      req.body.source?.trim(),
      destination: req.body.destination?.trim(),
      time: {
        $gte: new Date(rideTime.getTime() - windowMs),
        $lte: new Date(rideTime.getTime() + windowMs)
      }
    });
    if (existing) {
      return res.status(409).json({
        message: "A similar ride already exists within 30 minutes of this time.",
        existingRideId: existing._id
      });
    }

    const ride = await Ride.create({
      ...req.body,
      driverId: req.user.userId
    });
    res.status(201).json(ride);
  } catch (error) {
    res.status(400).json({ message: "Failed to create ride", error: error.message });
  }
});

// ── POST /api/rides/:id/rate ──────────────────────────────────────────────
router.post("/:id/rate", async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    return res.status(400).json({ message: "Invalid ride ID format" });
  }
  const { score } = req.body;
  const userId = req.user.userId;

  if (score === undefined) {
    return res.status(400).json({ message: "score is required" });
  }
  const numericScore = Number(score);
  if (Number.isNaN(numericScore) || numericScore < 1 || numericScore > 5) {
    return res.status(400).json({ message: "score must be a number between 1 and 5" });
  }

  try {
    const ride = await Ride.findById(req.params.id);
    if (!ride) return res.status(404).json({ message: "Ride not found" });

    const alreadyRated = ride.ratings.some(
      (r) => r.user && r.user.toString() === userId
    );
    if (alreadyRated) {
      return res.status(400).json({ message: "User has already rated this ride" });
    }

    ride.ratings.push({ user: userId, score: numericScore });
    const avg = ride.ratings.reduce((acc, r) => acc + r.score, 0) / ride.ratings.length;
    ride.averageRating = Number(avg.toFixed(2));
    await ride.save();

    return res.json({
      message: "Rating submitted successfully",
      averageRating: ride.averageRating,
      ratingsCount: ride.ratings.length
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to submit rating", error: error.message });
  }
});

// ── POST /api/rides/:id/request  (traveler requests a ride) ──────────────
router.post("/:id/request", async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    return res.status(400).json({ message: "Invalid ride ID format" });
  }
  if (req.user.role !== "traveler") {
    return res.status(403).json({ message: "Only travelers can request rides" });
  }

  const { travelerName, source, destination } = req.body;

  // FIX: identity always comes from JWT — never trust email from body
  const travelerEmail = req.user.email;
  const travelerId    = req.user.userId;

  if (!travelerName || !source || !destination) {
    return res.status(400).json({
      message: "travelerName, source and destination are required"
    });
  }

  try {
    const ride = await Ride.findById(req.params.id);
    if (!ride) return res.status(404).json({ message: "Ride not found" });

    if (ride.seatsAvailable <= 0) {
      return res.status(400).json({ message: "No seats available on this ride" });
    }

    // FIX: duplicate check uses authoritative travelerId from JWT
    const duplicate = ride.requests.some(
      (r) => r.travelerId?.toString() === travelerId
    );
    if (duplicate) {
      return res.status(400).json({ message: "Request already sent for this ride" });
    }

    ride.requests.push({ travelerId, travelerName, travelerEmail, source, destination });
    await ride.save();

    const created = ride.requests[ride.requests.length - 1];
    return res.status(201).json({
      message: "Ride request sent",
      requestsCount: ride.requests.length,
      request: created
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to send ride request", error: error.message });
  }
});

// ── PATCH /api/rides/:rideId/request/:requestId  (accept / reject) ────────
router.patch("/:rideId/request/:requestId", async (req, res) => {
  if (!isValidObjectId(req.params.rideId) || !isValidObjectId(req.params.requestId)) {
    return res.status(400).json({ message: "Invalid ride or request ID format" });
  }
  const { status } = req.body;

  if (!["accepted", "rejected", "pending"].includes(status)) {
    return res.status(400).json({ message: "status must be pending, accepted or rejected" });
  }

  try {
    // Read first to get auth context and previous status
    const ride = await Ride.findById(req.params.rideId);
    if (!ride) return res.status(404).json({ message: "Ride not found" });

    if (!ride.driverId || ride.driverId.toString() !== req.user.userId) {
      return res.status(403).json({ message: "Only the ride driver can update request status" });
    }

    const request = ride.requests.id(req.params.requestId);
    if (!request) return res.status(404).json({ message: "Request not found" });

    const previousStatus = request.status;

    // No-op
    if (previousStatus === status) {
      return res.json({ message: "Status unchanged", request, seatsAvailable: ride.seatsAvailable });
    }

    // FIX: atomic seat decrement — prevents overbooking under concurrent requests
    if (status === "accepted" && previousStatus !== "accepted") {
      const updated = await Ride.findOneAndUpdate(
        {
          _id: req.params.rideId,
          "requests._id": req.params.requestId,
          "requests.status": { $ne: "accepted" },
          seatsAvailable: { $gt: 0 }
        },
        {
          $inc: { seatsAvailable: -1 },
          $set: { "requests.$.status": "accepted" }
        },
        { new: true }
      );
      if (!updated) {
        return res.status(400).json({ message: "No seats available to accept this request" });
      }
      const updatedReq = updated.requests.id(req.params.requestId);
      return res.json({
        message: "Request status updated",
        request: updatedReq,
        seatsAvailable: updated.seatsAvailable
      });
    }

    // FIX: atomic seat restore when un-accepting
    if (previousStatus === "accepted" && status !== "accepted") {
      const updated = await Ride.findOneAndUpdate(
        {
          _id: req.params.rideId,
          "requests._id": req.params.requestId,
          "requests.status": "accepted"
        },
        {
          $inc: { seatsAvailable: 1 },
          $set: { "requests.$.status": status }
        },
        { new: true }
      );
      if (!updated) {
        return res.status(400).json({ message: "Could not update request status" });
      }
      const updatedReq = updated.requests.id(req.params.requestId);
      return res.json({
        message: "Request status updated",
        request: updatedReq,
        seatsAvailable: updated.seatsAvailable
      });
    }

    // Non-seat-affecting transition (e.g. pending → rejected)
    request.status = status;
    await ride.save();
    return res.json({ message: "Request status updated", request, seatsAvailable: ride.seatsAvailable });

  } catch (error) {
    return res.status(500).json({ message: "Failed to update request", error: error.message });
  }
});

// ── DELETE /api/rides/:id  (driver cancels their own ride) ────────────────
router.delete("/:id", async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    return res.status(400).json({ message: "Invalid ride ID format" });
  }
  try {
    const ride = await Ride.findById(req.params.id);
    if (!ride) return res.status(404).json({ message: "Ride not found" });

    const isDriver = ride.driverId && ride.driverId.toString() === req.user.userId;
    const isAdmin  = req.user.role === "admin";

    if (!isDriver && !isAdmin) {
      return res.status(403).json({ message: "Only the ride driver can cancel this ride" });
    }

    await ride.deleteOne();
    return res.json({ message: "Ride cancelled successfully" });
  } catch (error) {
    return res.status(500).json({ message: "Failed to cancel ride", error: error.message });
  }
});

// ── DELETE /api/rides/:id/request  (traveler cancels their own request) ───
router.delete("/:id/request", async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    return res.status(400).json({ message: "Invalid ride ID format" });
  }
  if (req.user.role !== "traveler") {
    return res.status(403).json({ message: "Only travelers can cancel their request" });
  }
  try {
    const ride = await Ride.findById(req.params.id);
    if (!ride) return res.status(404).json({ message: "Ride not found" });

    const reqIndex = ride.requests.findIndex(
      (r) => r.travelerId?.toString() === req.user.userId
    );
    if (reqIndex === -1) {
      return res.status(404).json({ message: "No request found for this traveler" });
    }

    const wasAccepted = ride.requests[reqIndex].status === "accepted";
    ride.requests.splice(reqIndex, 1);
    if (wasAccepted) ride.seatsAvailable += 1;

    await ride.save();
    return res.json({ message: "Request cancelled successfully", seatsAvailable: ride.seatsAvailable });
  } catch (error) {
    return res.status(500).json({ message: "Failed to cancel request", error: error.message });
  }
});

module.exports = router;
