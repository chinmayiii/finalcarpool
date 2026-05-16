/**
 * RATE LIMITER TEST
 * Each test uses resetModules for a fresh limiter state.
 * All requests use X-Forwarded-For (trust proxy is enabled in testApp).
 */

describe("Rate limiting on auth endpoints", () => {
  let request, app, User;

  beforeEach(() => {
    jest.resetModules();
    jest.mock("mongoose", () => ({
      ...jest.requireActual("mongoose"),
      connection: { readyState: 1 }
    }));
    jest.mock("../models/User", () => ({ findOne: jest.fn(), create: jest.fn() }));
    request = require("supertest");
    app     = require("./testApp");
    User    = require("../models/User");
    User.findOne.mockResolvedValue(null);
  });

  test("allows first 10 login attempts from same IP", async () => {
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", "203.0.113.1")
        .send({ email: `u${i}@test.com`, password: "pass" });
      expect(res.status).not.toBe(429);
    }
  });

  test("blocks 11th attempt with 429 and retry message", async () => {
    for (let i = 0; i < 10; i++) {
      await request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", "203.0.113.2")
        .send({ email: `u${i}@test.com`, password: "pass" });
    }
    const res = await request(app)
      .post("/api/auth/login")
      .set("X-Forwarded-For", "203.0.113.2")
      .send({ email: "overflow@test.com", password: "pass" });

    expect(res.status).toBe(429);
    expect(res.body.message).toMatch(/too many/i);
    expect(res.body.message).toMatch(/minute/i);
  });

  test("rate limit applies across all auth endpoints (login + register = 10 total)", async () => {
    // 8 logins + 2 register attempts = 10 total, 11th should fail
    for (let i = 0; i < 8; i++) {
      await request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", "203.0.113.3")
        .send({ email: `u@t.com`, password: "p" });
    }
    for (let i = 0; i < 2; i++) {
      await request(app)
        .post("/api/auth/register")
        .set("X-Forwarded-For", "203.0.113.3")
        .send({ name: "T", email: "t@t.com", mobileNumber: "9876543210", password: "password1", companyId: "X", location: "Y" });
    }
    const res = await request(app)
      .post("/api/auth/login")
      .set("X-Forwarded-For", "203.0.113.3")
      .send({ email: "u@t.com", password: "p" });

    expect(res.status).toBe(429);
  });

  test("different IPs have independent rate limits", async () => {
    // Exhaust IP A
    for (let i = 0; i <= 10; i++) {
      await request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", "203.0.113.4")
        .send({ email: "u@t.com", password: "p" });
    }
    // IP B should still work fine
    const res = await request(app)
      .post("/api/auth/login")
      .set("X-Forwarded-For", "203.0.113.5")
      .send({ email: "u@t.com", password: "p" });

    expect(res.status).not.toBe(429);
  });
});
