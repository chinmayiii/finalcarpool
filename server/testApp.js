const express = require("express");
const app = express();
app.set("trust proxy", 1); // honour X-Forwarded-For in tests
app.use(express.json());
app.use("/api/auth",  require("../routes/authRoutes"));
app.use("/api/rides", require("../routes/rideRoutes"));
module.exports = app;
