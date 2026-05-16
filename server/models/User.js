const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, "Name is required"],
    trim: true
  },
  email: {
    type: String,
    required: [true, "Email is required"],
    unique: true,           // DB-level unique index — prevents race condition duplicates
    lowercase: true,
    trim: true
  },
  mobileNumber: {
    type: String,
    required: [true, "Mobile number is required"]
  },
  password: {
    type: String,
    required: [true, "Password is required"]
  },
  role: {
    type: String,
    enum: ["traveler", "rider", "admin"],
    default: "traveler"
  },
  companyId: {
    type: String,
    required: [true, "Company ID is required"]
  },
  location: {
    type: String,
    required: [true, "Location is required"]
  },
  riderCredentials: {
    aadhaarNumber: String,
    vehicleNumber: String,
    vehicleModel: String,
    drivingLicenseNumber: String
  },
  ratings: [{
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    score: { type: Number, min: 1, max: 5 }
  }],
  averageRating: {
    type: Number,
    default: 0
  }
}, { timestamps: true });

module.exports = mongoose.model("User", userSchema);
