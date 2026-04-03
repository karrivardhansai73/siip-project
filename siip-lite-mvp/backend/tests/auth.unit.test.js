const { buildApp, createState } = require("../app");
const {
  FakeDb,
  FakeRedis,
  createBillingMock,
  createConfig,
  makeToken,
} = require("./helpers");

describe("webhook auth and deny paths", () => {
  let app;
  let db;
  let redis;
  let billing;

  beforeEach(() => {
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
  });

  afterEach(async () => {
    await app.close();
  });

  test("returns NO_TOKEN when auth header missing", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        "content-type": "application/json",
        "x-api-key": "student-dev-key",
      },
      payload: { amount: 100 },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().reason).toBe("NO_TOKEN");
  });

  test("returns NO_API_KEY when API key missing", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        authorization: makeToken(),
        "content-type": "application/json",
      },
      payload: { amount: 100 },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().reason).toBe("NO_API_KEY");
  });

  test("returns INVALID_API_KEY when API key is wrong", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/webhook",
      headers: {
        authorization: makeToken(),
        "x-api-key": "wrong",
        "content-type": "application/json",
      },
      payload: { amount: 100 },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().reason).toBe("INVALID_API_KEY");
  });

  test("blocks IP after repeated invalid token attempts", async () => {
    const headers = {
      authorization: "bad-token",
      "x-api-key": "student-dev-key",
      "content-type": "application/json",
    };

    for (let i = 0; i < 5; i += 1) {
      const denied = await app.inject({
        method: "POST",
        url: "/webhook",
        headers,
        payload: { amount: i },
        remoteAddress: "10.0.0.5",
      });
      expect(denied.statusCode).toBe(401);
      expect(denied.json().reason).toBe("INVALID_TOKEN");
    }

    const blocked = await app.inject({
      method: "POST",
      url: "/webhook",
      headers,
      payload: { amount: 999 },
      remoteAddress: "10.0.0.5",
    });

    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().reason).toBe("BLOCKED_IP");
  });
});
