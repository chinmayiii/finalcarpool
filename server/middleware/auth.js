const jwt = require("jsonwebtoken");

/**
 * Middleware: verifies the Bearer token in the Authorization header.
 * On success, attaches decoded payload to req.user.
 * Usage: router.post("/", authenticateToken, handler)
 */
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1]; // "Bearer <token>"

  if (!token) {
    return res.status(401).json({ message: "Access denied. No token provided." });
  }

  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "carpool-dev-secret"
    );
    req.user = decoded; // { userId, role, email }
    next();
  } catch (err) {
    return res.status(403).json({ message: "Invalid or expired token." });
  }
};

module.exports = { authenticateToken };
