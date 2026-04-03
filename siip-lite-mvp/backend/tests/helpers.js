const jwt = require("jsonwebtoken");

class FakeDb {
  constructor() {
    this.inserts = [];
  }

  async query(sql, values = []) {
    const normalized = String(sql).toUpperCase();
    if (normalized.includes("INSERT INTO REQUESTS")) {
      this.inserts.push({ sql, values });
    }
    return { rows: [] };
  }
}

class FakeRedis {
  constructor() {
    this.counts = new Map();
  }

  async incr(key) {
    const value = (this.counts.get(key) || 0) + 1;
    this.counts.set(key, value);
    return value;
  }

  async expire() {
    return 1;
  }
}

function createBillingMock() {
  return {
    post: jest.fn(async () => ({ data: { ok: true } })),
  };
}

function createConfig(overrides = {}) {
  return {
    backendPort: 3000,
    jwtSecret: "secret",
    apiKeys: ["student-dev-key"],
    billingUrl: "http://localhost:3001/receive",
    rateLimitPerMinute: 100,
    blockAfterFailedAuth: 5,
    failedAuthWindowSeconds: 60,
    offHoursStartUtc: 0,
    offHoursEndUtc: 0,
    maxPayloadBytes: 10000,
    highFreqPerMinute: 200,
    allowedTargetEndpoints: ["/receive"],
    maxRecentEvents: 50,
    ...overrides,
  };
}

function makeToken(payload = { user: "crm" }) {
  return jwt.sign(payload, "secret");
}

module.exports = {
  FakeDb,
  FakeRedis,
  createBillingMock,
  createConfig,
  makeToken,
};
