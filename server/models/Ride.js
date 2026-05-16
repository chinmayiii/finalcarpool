const mongoose = require("mongoose");

const requestSchema = new mongoose.Schema(
  {
    travelerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true        // FIX: always store the authoritative userId from JWT
    },
    travelerName: { type: String, required: true },
    travelerEmail: { type: String, required: true },
    source: { type: String, required: true },
    destination: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "accepted", "rejected"],
      default: "pending"
    }
  },
  { timestamps: true }
);

const rideSchema = new mongoose.Schema({
  driverId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User"
  },
  riderName: { type: String, required: true },
  riderMobile: { type: String, required: true },
  vehicleDetails: { type: String, required: true },
  source: { type: String, required: true },
  destination: { type: String, required: true },
  time: {
    type: Date,
    default: Date.now
  },
  sourceLocation: {
    type: {
      type: String,
      default: "Point"
    },
    coordinates: {
      type: [Number]      // [longitude, latitude]
    }
  },
  routePath: {
    type: {
      type: String,
      default: "LineString"
    },
    coordinates: {
      type: [[Number]]    // [[longitude, latitude], ...]
    }
  },
  seatsAvailable: {
    type: Number,
    required: true,
    min: [0, "Seats cannot be negative"]
  },
  passengers: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "User"
  }],
  ratings: [{
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    score: { type: Number, min: 1, max: 5 }
  }],
  averageRating: {
    type: Number,
    default: 0
  },
  requests: [requestSchema]
}, { timestamps: true });

rideSchema.index({ sourceLocation: "2dsphere" });
rideSchema.index({ routePath: "2dsphere" });
// FIX: compound index to prevent duplicate ride creation by same driver
rideSchema.index({ driverId: 1, source: 1, destination: 1, time: 1 });

module.exports = mongoose.model("Ride", rideSchema);
