const { buildApp, createState } = require("../app");
const {
  FakeDb,
  FakeRedis,
  createBillingMock,
  createConfig,
  makeToken,
} = require("./helpers");

describe("webhook integration behavior", () => {
  let app;
  let db;
  let redis;
  let billing;

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  test("allows valid request, forwards payload, and writes audit log", async () => {
    db = new FakeDb();
    redis = new FakeRedis();
    billing = createBillingMock();

    app = buildApp({
      config: createConfig(),
      state: createState(),
      dbClient: db,
      redisClient: redis,
      billingClient: billing,
      broadcast: () => {},
    });

    const payload = {
      amount: 500,
      customer: "John",
      targetEndpoint: "/receive",
    };

    const response = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        authorization: makeToken({ user: "crm" }),
        "x-api-key": "student-dev-key",
        "content-type": "application/json",
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().verdict).toBe("ALLOW");
    expect(billing.post).toHaveBeenCalledTimes(1);
    expect(billing.post).toHaveBeenCalledWith("http://localhost:3001/receive", payload);
    expect(db.inserts.length).toBeGreaterThan(0);
  });

  test("returns 429 with Retry-After when rate limit is exceeded", async () => {
    db = new FakeDb();
    redis = new FakeRedis();
    billing = createBillingMock();

    app = buildApp({
      config: createConfig({ rateLimitPerMinute: 2 }),
      state: createState(),
      dbClient: db,
      redisClient: redis,
      billingClient: billing,
      broadcast: () => {},
    });

    const headers = {
      authorization: makeToken({ user: "crm" }),
      "x-api-key": "student-dev-key",
      "content-type": "application/json",
    };

    await app.inject({ method: "POST", url: "/webhook", headers, payload: { i: 1 } });
    await app.inject({ method: "POST", url: "/webhook", headers, payload: { i: 2 } });

    const blocked = await app.inject({
      method: "POST",
      url: "/webhook",
      headers,
      payload: { i: 3 },
    });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBe("60");
    expect(blocked.json().reason).toBe("RATE_LIMIT");
  });

  test("denies endpoint drift when target endpoint is not allowlisted", async () => {
    db = new FakeDb();
    redis = new FakeRedis();
    billing = createBillingMock();

    app = buildApp({
      config: createConfig({ allowedTargetEndpoints: ["/receive"] }),
      state: createState(),
      dbClient: db,
      redisClient: redis,
      billingClient: billing,
      broadcast: () => {},
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        authorization: makeToken({ user: "crm" }),
        "x-api-key": "student-dev-key",
        "content-type": "application/json",
      },
      payload: {
        amount: 50,
        targetEndpoint: "/admin/reset",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().reason).toBe("ENDPOINT_DRIFT");
    expect(billing.post).toHaveBeenCalledTimes(0);
  });
});
