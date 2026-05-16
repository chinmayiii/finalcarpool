/**
 * RIDE ROUTE TESTS
 * FIX: Ride mock renamed to mockRideModel (jest requires mock variables to start with "mock")
 */

const request = require("supertest");
const jwt     = require("jsonwebtoken");

const SECRET = "carpool-dev-secret";

const riderToken     = jwt.sign({ userId: "driver001", role: "rider",    email: "driver@corp.com"   }, SECRET);
const travelerToken  = jwt.sign({ userId: "traveler1", role: "traveler", email: "traveler@corp.com" }, SECRET);
const traveler2Token = jwt.sign({ userId: "traveler2", role: "traveler", email: "other@corp.com"    }, SECRET);
const adminToken     = jwt.sign({ userId: "admin001",  role: "admin",    email: "admin@corp.com"    }, SECRET);

// ── Mock Mongoose ──────────────────────────────────────────────────────────
jest.mock("mongoose", () => {
  const actual = jest.requireActual("mongoose");
  return {
    ...actual,
    connection: { readyState: 1 },
    Types: { ObjectId: { isValid: (id) => /^[a-f\d]{24}$/i.test(String(id)) } }
  };
});

// ── Mock Ride model — variable MUST start with "mock" (Jest hoisting rule) ──
const mockRideModel = {
  find:             jest.fn(),
  findOne:          jest.fn(),
  findById:         jest.fn(),
  findOneAndUpdate: jest.fn(),
  create:           jest.fn(),
  countDocuments:   jest.fn()
};
jest.mock("../models/Ride", () => mockRideModel);

const makeRide = (overrides = {}) => ({
  _id: "aaaaaaaaaaaaaaaaaaaaaaaa",
  driverId: { toString: () => "driver001" },
  source: "Koramangala", destination: "Whitefield",
  seatsAvailable: 2, riderName: "Driver", riderMobile: "9876543210",
  vehicleDetails: "Swift DZire KA01AB1234",
  requests: [],
  ratings: [], averageRating: 0,
  save: jest.fn().mockResolvedValue(true),
  deleteOne: jest.fn().mockResolvedValue(true),
  ...overrides
});

const app = require("./testApp");

beforeEach(() => jest.clearAllMocks());

// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/rides — ride creation & dedup", () => {
  const validBody = {
    source: "Koramangala", destination: "Whitefield",
    time: new Date(Date.now() + 3600000).toISOString(),
    seatsAvailable: 3, riderName: "Driver",
    riderMobile: "9876543210", vehicleDetails: "Swift DZire KA01AB1234"
  };

  test("returns 409 when driver creates duplicate ride within 30-min window", async () => {
    mockRideModel.findOne.mockResolvedValue(makeRide({ _id: "existingride00000000000" }));
    const res = await request(app)
      .post("/api/rides")
      .set("Authorization", `Bearer ${riderToken}`)
      .send(validBody);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already exists/i);
    expect(res.body.existingRideId).toBeDefined();
    expect(mockRideModel.create).not.toHaveBeenCalled();
  });

  test("creates ride when no duplicate exists", async () => {
    mockRideModel.findOne.mockResolvedValue(null);
    mockRideModel.create.mockResolvedValue({ ...validBody, _id: "newride000000000000000", driverId: "driver001" });
    const res = await request(app)
      .post("/api/rides")
      .set("Authorization", `Bearer ${riderToken}`)
      .send(validBody);
    expect(res.status).toBe(201);
    expect(mockRideModel.create).toHaveBeenCalledTimes(1);
  });

  test("returns 403 when traveler tries to create a ride", async () => {
    const res = await request(app)
      .post("/api/rides")
      .set("Authorization", `Bearer ${travelerToken}`)
      .send(validBody);
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/only riders/i);
  });

  test("returns 401 with no token", async () => {
    const res = await request(app).post("/api/rides").send(validBody);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/rides/:id/request — traveler request & dedup", () => {
  const RIDE_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";

  test("blocks duplicate request using travelerId from JWT (not email)", async () => {
    const ride = makeRide({
      requests: [{
        travelerId: { toString: () => "traveler1" },
        travelerEmail: "some-other-email@corp.com", // different email — old bug passed this
        status: "pending"
      }]
    });
    mockRideModel.findById.mockResolvedValue(ride);
    const res = await request(app)
      .post(`/api/rides/${RIDE_ID}/request`)
      .set("Authorization", `Bearer ${travelerToken}`)
      .send({ travelerName: "Traveler", source: "HSR", destination: "Whitefield" });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already sent/i);
  });

  test("stores travelerEmail from JWT — ignores spoofed email in body", async () => {
    const ride = makeRide();
    const pushed = [];
    ride.requests.push = (obj) => pushed.push(obj);
    mockRideModel.findById.mockResolvedValue(ride);

    await request(app)
      .post(`/api/rides/${RIDE_ID}/request`)
      .set("Authorization", `Bearer ${travelerToken}`)
      .send({
        travelerName: "Traveler",
        travelerEmail: "SPOOFED@hacker.com",
        source: "HSR", destination: "Whitefield"
      });

    expect(pushed[0].travelerEmail).toBe("traveler@corp.com"); // from JWT
    expect(pushed[0].travelerId).toBe("traveler1");            // from JWT
    expect(pushed[0].travelerEmail).not.toBe("SPOOFED@hacker.com");
  });

  test("returns 403 when rider tries to request a ride", async () => {
    const res = await request(app)
      .post(`/api/rides/${RIDE_ID}/request`)
      .set("Authorization", `Bearer ${riderToken}`)
      .send({ travelerName: "D", source: "A", destination: "B" });
    expect(res.status).toBe(403);
  });

  test("returns 400 when ride has no seats", async () => {
    mockRideModel.findById.mockResolvedValue(makeRide({ seatsAvailable: 0 }));
    const res = await request(app)
      .post(`/api/rides/${RIDE_ID}/request`)
      .set("Authorization", `Bearer ${travelerToken}`)
      .send({ travelerName: "Traveler", source: "HSR", destination: "MG Road" });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/no seats/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("PATCH /api/rides/:rideId/request/:requestId — atomic seat management", () => {
  const RIDE_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
  const REQ_ID  = "bbbbbbbbbbbbbbbbbbbbbbbb";

  const makePendingReq = () => ({
    _id: REQ_ID, travelerId: { toString: () => "traveler1" }, status: "pending"
  });

  test("uses findOneAndUpdate with seatsAvailable $gt:0 when accepting", async () => {
    const pendingReq = makePendingReq();
    const ride = makeRide({ requests: [pendingReq] });
    ride.requests.id = () => pendingReq;
    mockRideModel.findById.mockResolvedValue(ride);

    const updatedRide = makeRide({ seatsAvailable: 1 });
    const acceptedReq = { ...pendingReq, status: "accepted" };
    updatedRide.requests.id = () => acceptedReq;
    mockRideModel.findOneAndUpdate.mockResolvedValue(updatedRide);

    const res = await request(app)
      .patch(`/api/rides/${RIDE_ID}/request/${REQ_ID}`)
      .set("Authorization", `Bearer ${riderToken}`)
      .send({ status: "accepted" });

    expect(res.status).toBe(200);
    expect(mockRideModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ seatsAvailable: { $gt: 0 } }),
      expect.objectContaining({ $inc: { seatsAvailable: -1 } }),
      expect.anything()
    );
  });

  test("returns 400 when atomic guard fires (no seats left)", async () => {
    const pendingReq = makePendingReq();
    const ride = makeRide({ seatsAvailable: 0, requests: [pendingReq] });
    ride.requests.id = () => pendingReq;
    mockRideModel.findById.mockResolvedValue(ride);
    mockRideModel.findOneAndUpdate.mockResolvedValue(null); // guard returned null

    const res = await request(app)
      .patch(`/api/rides/${RIDE_ID}/request/${REQ_ID}`)
      .set("Authorization", `Bearer ${riderToken}`)
      .send({ status: "accepted" });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/no seats/i);
  });

  test("restores seat with $inc +1 when un-accepting", async () => {
    const acceptedReq = { ...makePendingReq(), status: "accepted" };
    const ride = makeRide({ requests: [acceptedReq] });
    ride.requests.id = () => acceptedReq;
    mockRideModel.findById.mockResolvedValue(ride);

    const updatedRide = makeRide({ seatsAvailable: 3 });
    updatedRide.requests.id = () => ({ ...acceptedReq, status: "rejected" });
    mockRideModel.findOneAndUpdate.mockResolvedValue(updatedRide);

    const res = await request(app)
      .patch(`/api/rides/${RIDE_ID}/request/${REQ_ID}`)
      .set("Authorization", `Bearer ${riderToken}`)
      .send({ status: "rejected" });

    expect(res.status).toBe(200);
    expect(mockRideModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ "requests.status": "accepted" }),
      expect.objectContaining({ $inc: { seatsAvailable: 1 } }),
      expect.anything()
    );
  });

  test("returns 403 when non-driver tries to accept", async () => {
    const pendingReq = makePendingReq();
    const ride = makeRide({ requests: [pendingReq] });
    ride.requests.id = () => pendingReq;
    mockRideModel.findById.mockResolvedValue(ride);

    const res = await request(app)
      .patch(`/api/rides/${RIDE_ID}/request/${REQ_ID}`)
      .set("Authorization", `Bearer ${travelerToken}`)
      .send({ status: "accepted" });

    expect(res.status).toBe(403);
  });

  test("returns 400 for invalid status value", async () => {
    const res = await request(app)
      .patch(`/api/rides/${RIDE_ID}/request/${REQ_ID}`)
      .set("Authorization", `Bearer ${riderToken}`)
      .send({ status: "maybe" });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("GET /api/rides — pagination", () => {
  test("returns rides with pagination metadata", async () => {
    mockRideModel.find.mockReturnValue({
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([makeRide()])
    });
    mockRideModel.countDocuments.mockResolvedValue(45);

    const res = await request(app)
      .get("/api/rides?page=2&limit=10")
      .set("Authorization", `Bearer ${travelerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.pagination).toEqual(
      expect.objectContaining({ page: 2, limit: 10, total: 45, pages: 5 })
    );
    expect(Array.isArray(res.body.rides)).toBe(true);
  });

  test("defaults to page=1, limit=20", async () => {
    const chain = {
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([])
    };
    mockRideModel.find.mockReturnValue(chain);
    mockRideModel.countDocuments.mockResolvedValue(0);

    await request(app)
      .get("/api/rides")
      .set("Authorization", `Bearer ${travelerToken}`);

    expect(chain.skip).toHaveBeenCalledWith(0);
    expect(chain.limit).toHaveBeenCalledWith(20);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("DELETE /api/rides/:id — ride cancellation", () => {
  const RIDE_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";

  test("driver can delete their own ride", async () => {
    const ride = makeRide();
    mockRideModel.findById.mockResolvedValue(ride);
    const res = await request(app)
      .delete(`/api/rides/${RIDE_ID}`)
      .set("Authorization", `Bearer ${riderToken}`);
    expect(res.status).toBe(200);
    expect(ride.deleteOne).toHaveBeenCalled();
  });

  test("admin can delete any ride", async () => {
    const ride = makeRide();
    mockRideModel.findById.mockResolvedValue(ride);
    const res = await request(app)
      .delete(`/api/rides/${RIDE_ID}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(ride.deleteOne).toHaveBeenCalled();
  });

  test("traveler cannot delete a ride", async () => {
    mockRideModel.findById.mockResolvedValue(makeRide());
    const res = await request(app)
      .delete(`/api/rides/${RIDE_ID}`)
      .set("Authorization", `Bearer ${travelerToken}`);
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("DELETE /api/rides/:id/request — traveler cancels booking", () => {
  const RIDE_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";

  test("traveler cancels accepted booking — seat restored", async () => {
    const ride = makeRide({
      seatsAvailable: 1,
      requests: [{ travelerId: { toString: () => "traveler1" }, status: "accepted" }]
    });
    mockRideModel.findById.mockResolvedValue(ride);

    const res = await request(app)
      .delete(`/api/rides/${RIDE_ID}/request`)
      .set("Authorization", `Bearer ${travelerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.seatsAvailable).toBe(2);
    expect(ride.save).toHaveBeenCalled();
  });

  test("traveler cancels pending request — seat NOT restored", async () => {
    const ride = makeRide({
      seatsAvailable: 2,
      requests: [{ travelerId: { toString: () => "traveler1" }, status: "pending" }]
    });
    mockRideModel.findById.mockResolvedValue(ride);

    const res = await request(app)
      .delete(`/api/rides/${RIDE_ID}/request`)
      .set("Authorization", `Bearer ${travelerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.seatsAvailable).toBe(2); // unchanged
  });

  test("returns 403 when rider calls traveler-only endpoint", async () => {
    const res = await request(app)
      .delete(`/api/rides/${RIDE_ID}/request`)
      .set("Authorization", `Bearer ${riderToken}`);
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("Input validation", () => {
  test("returns 400 for malformed ride ID", async () => {
    const res = await request(app)
      .get("/api/rides/not-a-real-id")
      .set("Authorization", `Bearer ${travelerToken}`);
    expect(res.status).toBe(400);
  });

  test("rating: blocks double-rating from same user", async () => {
    const ride = makeRide({
      ratings: [{ user: { toString: () => "traveler1" }, score: 4 }]
    });
    mockRideModel.findById.mockResolvedValue(ride);
    const res = await request(app)
      .post("/api/rides/aaaaaaaaaaaaaaaaaaaaaaaa/rate")
      .set("Authorization", `Bearer ${travelerToken}`)
      .send({ score: 5 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already rated/i);
  });

  test("rating: rejects score > 5", async () => {
    mockRideModel.findById.mockResolvedValue(makeRide());
    const res = await request(app)
      .post("/api/rides/aaaaaaaaaaaaaaaaaaaaaaaa/rate")
      .set("Authorization", `Bearer ${travelerToken}`)
      .send({ score: 6 });
    expect(res.status).toBe(400);
  });
});
