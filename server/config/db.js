"use strict";

/**
 * db.js — MongoDB Atlas connection helper.
 *
 * Used by scripts and tests that need a direct connection outside the
 * main server. The main server (server.js) calls connectDB internally
 * with its own retry logic.
 *
 * Usage:
 *   const connectDB = require("./config/db");
 *   await connectDB();
 */

const mongoose = require("mongoose");

const connectDB = async () => {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI environment variable is not set.");
  }

  if (mongoose.connection.readyState === 1) {
    // Already connected — reuse the existing connection
    return;
  }

  try {
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS:          45000,
      maxPoolSize: 10,
      minPoolSize: 2,
    });
    console.log("MongoDB Atlas connected:", process.env.MONGO_URI.replace(/\/\/.*@/, "//<credentials>@"));
  } catch (error) {
    console.error("MongoDB connection error:", error.message);
    throw error;
  }
};

module.exports = connectDB;
