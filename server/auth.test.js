/**
 * AUTH ROUTE TESTS
 * Each describe block re-requires a fresh app so rate limiter state is isolated.
 */

const bcrypt = require("bcryptjs");

// ── Shared mock setup ──────────────────────────────────────────────────────
const mockUser = {
  _id: "user123", name: "Test User", email: "test@corp.com",
  role: "traveler", mobileNumber: "9876543210",
  password: bcrypt.hashSync("password123", 1),
  riderCredentials: null
};

// Reset module registry before every test so rate-limiter Map starts empty
let request, app, User, OAuth2Client;

beforeEach(() => {
  jest.resetModules();

  jest.mock("mongoose", () => ({
    ...jest.requireActual("mongoose"),
    connection: { readyState: 1 },
  }));
  jest.mock("../models/User", () => ({ findOne: jest.fn(), create: jest.fn() }));
  jest.mock("google-auth-library", () => ({
    OAuth2Client: jest.fn().mockImplementation(() => ({
      verifyIdToken: jest.fn()
    }))
  }));

  request    = require("supertest");
  app        = require("./testApp");
  User       = require("../models/User");
  const gal  = require("google-auth-library");
  OAuth2Client = gal.OAuth2Client;
});

// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/auth/register", () => {

  test("blocks admin self-registration", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({
        name: "Hacker", email: "h@corp.com", mobileNumber: "9876543210",
        password: "password123", companyId: "CORP", location: "Bengaluru",
        role: "admin"
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/traveler or rider/i);
  });

  test("accepts traveler registration", async () => {
    User.findOne.mockResolvedValue(null);
    User.create.mockResolvedValue({ ...mockUser, role: "traveler" });
    const res = await request(app)
      .post("/api/auth/register")
      .send({
        name: "Test", email: "test@corp.com", mobileNumber: "9876543210",
        password: "password123", companyId: "CORP", location: "Bengaluru",
        role: "traveler"
      });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe("traveler");
  });

  test("rejects weak password (< 8 chars)", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({
        name: "Test", email: "t@c.com", mobileNumber: "9876543210",
        password: "short", companyId: "CORP", location: "Bengaluru"
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/8 characters/i);
  });

  test("rejects duplicate email", async () => {
    User.findOne.mockResolvedValue(mockUser);
    const res = await request(app)
      .post("/api/auth/register")
      .send({
        name: "Test", email: "test@corp.com", mobileNumber: "9876543210",
        password: "password123", companyId: "CORP", location: "Bengaluru"
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already registered/i);
  });

  test("rejects invalid mobile number", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({
        name: "Test", email: "t@c.com", mobileNumber: "123",
        password: "password123", companyId: "CORP", location: "Bengaluru"
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/10 digits/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/auth/login", () => {

  test("returns token for correct credentials", async () => {
    User.findOne.mockResolvedValue(mockUser);
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "test@corp.com", password: "password123" });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
  });

  test("returns 401 for wrong password", async () => {
    User.findOne.mockResolvedValue(mockUser);
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "test@corp.com", password: "wrongpass" });
    expect(res.status).toBe(401);
  });

  test("returns 401 for unknown email", async () => {
    User.findOne.mockResolvedValue(null);
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody@corp.com", password: "password123" });
    expect(res.status).toBe(401);
  });

  test("returns 400 when fields missing", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "test@corp.com" });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/auth/google", () => {

  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = "fake-client-id";
  });

  test("auto-creates traveler account for new Google user (was 404)", async () => {
    OAuth2Client.mockImplementation(() => ({
      verifyIdToken: jest.fn().mockResolvedValue({
        getPayload: () => ({ email: "new@gmail.com", name: "New", email_verified: true })
      })
    }));
    User.findOne.mockResolvedValue(null);
    User.create.mockResolvedValue({
      _id: "new456", name: "New", email: "new@gmail.com",
      role: "traveler", mobileNumber: "0000000000", riderCredentials: null
    });

    const res = await request(app)
      .post("/api/auth/google")
      .send({ idToken: "fake-token" });

    expect(res.status).toBe(201);
    expect(res.body.isNewUser).toBe(true);
    expect(res.body.token).toBeDefined();
    expect(User.create).toHaveBeenCalledTimes(1);
  });

  test("logs in existing Google user normally", async () => {
    OAuth2Client.mockImplementation(() => ({
      verifyIdToken: jest.fn().mockResolvedValue({
        getPayload: () => ({ email: "test@corp.com", name: "Test", email_verified: true })
      })
    }));
    User.findOne.mockResolvedValue(mockUser);

    const res = await request(app)
      .post("/api/auth/google")
      .send({ idToken: "fake-token" });

    expect(res.status).toBe(200);
    expect(res.body.isNewUser).toBeFalsy();   // false for existing user, not undefined
    expect(res.body.token).toBeDefined();
  });

  test("rejects unverified Google email", async () => {
    OAuth2Client.mockImplementation(() => ({
      verifyIdToken: jest.fn().mockResolvedValue({
        getPayload: () => ({ email: "bad@gmail.com", email_verified: false })
      })
    }));
    const res = await request(app)
      .post("/api/auth/google")
      .send({ idToken: "fake-token" });
    expect(res.status).toBe(401);
  });

  test("returns 400 when idToken missing", async () => {
    const res = await request(app)
      .post("/api/auth/google")
      .send({});
    expect(res.status).toBe(400);
  });
});
