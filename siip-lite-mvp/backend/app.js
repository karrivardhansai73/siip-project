const Fastify = require("fastify");
const cors = require("@fastify/cors");
const jwt = require("jsonwebtoken");

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseList(value, fallback) {
  if (!value) {
    return fallback;
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function loadConfigFromEnv(env = process.env) {
  return {
    backendPort: parseInteger(env.BACKEND_PORT, 3000),
    jwtSecret: env.JWT_SECRET || "secret",
    apiKeys: parseList(env.API_KEYS, ["student-dev-key"]),
    billingUrl: env.BILLING_URL || "http://localhost:3001/receive",
    rateLimitPerMinute: parseInteger(env.RATE_LIMIT_PER_MIN, 100),
    blockAfterFailedAuth: parseInteger(env.BLOCK_AFTER_FAILED_AUTH, 5),
    failedAuthWindowSeconds: parseInteger(env.FAILED_AUTH_WINDOW_SECONDS, 60),
    offHoursStartUtc: parseInteger(env.OFF_HOURS_START_UTC, 0),
    offHoursEndUtc: parseInteger(env.OFF_HOURS_END_UTC, 5),
    maxPayloadBytes: parseInteger(env.MAX_PAYLOAD_BYTES, 10000),
    highFreqPerMinute: parseInteger(env.HIGH_FREQ_PER_MIN, 200),
    allowedTargetEndpoints: parseList(env.ALLOWED_TARGET_ENDPOINTS, ["/receive"]),
    maxRecentEvents: parseInteger(env.MAX_RECENT_EVENTS, 50),
  };
}

function createState() {
  return {
    blockedIps: new Set(),
    failedAuthByIp: new Map(),
    stats: {
      allow: 0,
      deny: 0,
      rateLimit: 0,
      blocked: 0,
      alerts: 0,
    },
    recentEvents: [],
    alerts: [],
  };
}

function createNoopRedis() {
  return {
    async incr() {
      return 1;
    },
    async expire() {
      return 1;
    },
  };
}

function createNoopDb() {
  return {
    async query() {
      return { rows: [] };
    },
  };
}

function getPayloadSize(body) {
  if (!body) {
    return 0;
  }
  return Buffer.byteLength(JSON.stringify(body), "utf8");
}

function isOffHours(config) {
  const hour = new Date().getUTCHours();
  return hour >= config.offHoursStartUtc && hour < config.offHoursEndUtc;
}

function addRecentEvent(state, config, event) {
  state.recentEvents.unshift(event);
  if (state.recentEvents.length > config.maxRecentEvents) {
    state.recentEvents.length = config.maxRecentEvents;
  }
}

function pushAlert(state, config, broadcast, alert) {
  state.stats.alerts += 1;
  state.alerts.unshift(alert);
  if (state.alerts.length > config.maxRecentEvents) {
    state.alerts.length = config.maxRecentEvents;
  }
  broadcast({ type: "alert", ...alert });
}

function createDenyResponder({ app, config, state, dbClient, broadcast }) {
  return async function deny(reply, details) {
    const {
      reason,
      statusCode,
      ip,
      endpoint,
      method,
      identity,
      payloadSize,
      latencyMs,
      requestBody,
      addRetryAfter,
    } = details;

    if (reason === "RATE_LIMIT") {
      state.stats.rateLimit += 1;
    }

    if (reason === "BLOCKED_IP") {
      state.stats.blocked += 1;
    }

    state.stats.deny += 1;

    const event = {
      type: "request",
      verdict: "DENY",
      reason,
      ip,
      endpoint,
      method,
      identity,
      statusCode,
      latencyMs,
      at: new Date().toISOString(),
    };

    addRecentEvent(state, config, event);
    broadcast({ type: "request", ip, status: "DENY", reason });

    await dbClient.query(
      `INSERT INTO requests (
        request_time,
        source_ip,
        endpoint,
        method,
        service_identity,
        status_code,
        latency_ms,
        payload_size,
        verdict,
        reason,
        request_body
      ) VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        ip,
        endpoint,
        method,
        identity,
        statusCode,
        latencyMs,
        payloadSize,
        "DENY",
        reason,
        JSON.stringify(requestBody || {}),
      ]
    );

    if (addRetryAfter) {
      reply.header("Retry-After", "60");
    }

    reply.code(statusCode);
    return {
      ok: false,
      verdict: "DENY",
      reason,
      message: app.reasonMessages[reason] || "Request denied",
    };
  };
}

async function ensureSchema(dbClient) {
  await dbClient.query(`
    CREATE TABLE IF NOT EXISTS requests (
      id SERIAL PRIMARY KEY,
      request_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source_ip TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      method TEXT NOT NULL,
      service_identity TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      payload_size INTEGER NOT NULL,
      verdict TEXT NOT NULL,
      reason TEXT NOT NULL,
      request_body JSONB NOT NULL
    )
  `);

  await dbClient.query("ALTER TABLE requests ADD COLUMN IF NOT EXISTS request_time TIMESTAMPTZ DEFAULT NOW()");
  await dbClient.query("ALTER TABLE requests ADD COLUMN IF NOT EXISTS endpoint TEXT DEFAULT '/webhook'");
  await dbClient.query("ALTER TABLE requests ADD COLUMN IF NOT EXISTS method TEXT DEFAULT 'POST'");
  await dbClient.query("ALTER TABLE requests ADD COLUMN IF NOT EXISTS service_identity TEXT DEFAULT 'unknown'");
  await dbClient.query("ALTER TABLE requests ADD COLUMN IF NOT EXISTS status_code INTEGER DEFAULT 200");
  await dbClient.query("ALTER TABLE requests ADD COLUMN IF NOT EXISTS latency_ms INTEGER DEFAULT 0");
  await dbClient.query("ALTER TABLE requests ADD COLUMN IF NOT EXISTS payload_size INTEGER DEFAULT 0");
  await dbClient.query("ALTER TABLE requests ADD COLUMN IF NOT EXISTS reason TEXT DEFAULT 'MIGRATED'");
  await dbClient.query("ALTER TABLE requests ADD COLUMN IF NOT EXISTS request_body JSONB DEFAULT '{}'::jsonb");

  await dbClient.query("UPDATE requests SET request_time = NOW() WHERE request_time IS NULL");
  await dbClient.query("UPDATE requests SET endpoint = '/webhook' WHERE endpoint IS NULL");
  await dbClient.query("UPDATE requests SET method = 'POST' WHERE method IS NULL");
  await dbClient.query("UPDATE requests SET service_identity = 'unknown' WHERE service_identity IS NULL");
  await dbClient.query("UPDATE requests SET status_code = 200 WHERE status_code IS NULL");
  await dbClient.query("UPDATE requests SET latency_ms = 0 WHERE latency_ms IS NULL");
  await dbClient.query("UPDATE requests SET payload_size = 0 WHERE payload_size IS NULL");
  await dbClient.query("UPDATE requests SET reason = 'MIGRATED' WHERE reason IS NULL");
  await dbClient.query("UPDATE requests SET request_body = '{}'::jsonb WHERE request_body IS NULL");
}

function buildApp(options = {}) {
  const config = options.config || loadConfigFromEnv();
  const state = options.state || createState();
  const dbClient = options.dbClient || createNoopDb();
  const redisClient = options.redisClient || createNoopRedis();
  const billingClient = options.billingClient;
  const broadcast = options.broadcast || (() => {});

  if (!billingClient || typeof billingClient.post !== "function") {
    throw new Error("billingClient with post method is required");
  }

  const app = Fastify({ logger: true });

  app.reasonMessages = {
    NO_TOKEN: "Authorization token is required",
    NO_API_KEY: "API key is required",
    INVALID_TOKEN: "Authorization token is invalid",
    INVALID_API_KEY: "API key is invalid",
    RATE_LIMIT: "Too many requests",
    BLOCKED_IP: "Source IP is blocked",
    ENDPOINT_DRIFT: "Requested target endpoint is not allowed",
    BILLING_FORWARD_FAILED: "Could not forward request to billing",
  };

  app.decorate("state", state);
  app.decorate("config", config);
  app.decorate("ensureSchema", async () => ensureSchema(dbClient));

  app.register(cors, { origin: true });

  app.get("/", async () => ({
    message: "SIIP Backend Running",
    rateLimitPerMinute: config.rateLimitPerMinute,
  }));

  app.get("/health", async () => ({ ok: true, now: new Date().toISOString() }));

  app.get("/dashboard/summary", async () => ({
    stats: state.stats,
    blockedIps: Array.from(state.blockedIps),
    latestEvents: state.recentEvents,
    latestAlerts: state.alerts,
  }));

  const deny = createDenyResponder({ app, config, state, dbClient, broadcast });

  app.post("/webhook", async (req, reply) => {
    const startedAt = Date.now();
    const ip = req.ip;
    const endpoint = req.url;
    const method = req.method;
    const payloadSize = getPayloadSize(req.body);
    const requestBody = req.body || {};

    if (state.blockedIps.has(ip)) {
      return deny(reply, {
        reason: "BLOCKED_IP",
        statusCode: 403,
        ip,
        endpoint,
        method,
        identity: "unknown",
        payloadSize,
        latencyMs: Date.now() - startedAt,
        requestBody,
      });
    }

    const token = req.headers.authorization;
    const apiKey = req.headers["x-api-key"];

    if (!token) {
      return deny(reply, {
        reason: "NO_TOKEN",
        statusCode: 401,
        ip,
        endpoint,
        method,
        identity: "unknown",
        payloadSize,
        latencyMs: Date.now() - startedAt,
        requestBody,
      });
    }

    if (!apiKey) {
      return deny(reply, {
        reason: "NO_API_KEY",
        statusCode: 401,
        ip,
        endpoint,
        method,
        identity: "unknown",
        payloadSize,
        latencyMs: Date.now() - startedAt,
        requestBody,
      });
    }

    if (!config.apiKeys.includes(String(apiKey))) {
      return deny(reply, {
        reason: "INVALID_API_KEY",
        statusCode: 401,
        ip,
        endpoint,
        method,
        identity: "unknown",
        payloadSize,
        latencyMs: Date.now() - startedAt,
        requestBody,
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, config.jwtSecret);
    } catch (error) {
      const now = Date.now();
      const existing = state.failedAuthByIp.get(ip) || { count: 0, firstAt: now };
      if (now - existing.firstAt > config.failedAuthWindowSeconds * 1000) {
        existing.count = 0;
        existing.firstAt = now;
      }
      existing.count += 1;
      state.failedAuthByIp.set(ip, existing);

      if (existing.count >= config.blockAfterFailedAuth) {
        state.blockedIps.add(ip);
        state.stats.blocked += 1;

        const alert = {
          severity: "CRITICAL",
          rule: "REPEATED_AUTH_FAILURE",
          ip,
          at: new Date().toISOString(),
          detail: `IP blocked after ${existing.count} failed JWT validations`,
        };
        pushAlert(state, config, broadcast, alert);
        broadcast({ type: "blocked", ip, reason: "REPEATED_AUTH_FAILURE" });
      }

      return deny(reply, {
        reason: "INVALID_TOKEN",
        statusCode: 401,
        ip,
        endpoint,
        method,
        identity: "unknown",
        payloadSize,
        latencyMs: Date.now() - startedAt,
        requestBody,
      });
    }

    state.failedAuthByIp.delete(ip);

    const identity = decoded.user || decoded.sub || "service";
    const rateKey = `rl:${identity}`;
    const current = await redisClient.incr(rateKey);
    if (current === 1) {
      await redisClient.expire(rateKey, 60);
    }

    if (current > config.rateLimitPerMinute) {
      return deny(reply, {
        reason: "RATE_LIMIT",
        statusCode: 429,
        ip,
        endpoint,
        method,
        identity,
        payloadSize,
        latencyMs: Date.now() - startedAt,
        requestBody,
        addRetryAfter: true,
      });
    }

    if (current > config.highFreqPerMinute) {
      pushAlert(state, config, broadcast, {
        severity: "WARNING",
        rule: "HIGH_CALL_FREQUENCY",
        ip,
        identity,
        at: new Date().toISOString(),
        detail: `Observed ${current} calls/minute`,
      });
    }

    if (isOffHours(config)) {
      pushAlert(state, config, broadcast, {
        severity: "INFO",
        rule: "OFF_HOURS_ACCESS",
        ip,
        identity,
        at: new Date().toISOString(),
        detail: "Traffic arrived during configured off-hours window",
      });
    }

    if (payloadSize > config.maxPayloadBytes) {
      pushAlert(state, config, broadcast, {
        severity: "WARNING",
        rule: "PAYLOAD_SIZE_ANOMALY",
        ip,
        identity,
        at: new Date().toISOString(),
        detail: `Payload size ${payloadSize} bytes exceeded threshold ${config.maxPayloadBytes}`,
      });
    }

    const targetEndpoint = requestBody.targetEndpoint || "/receive";
    if (!config.allowedTargetEndpoints.includes(targetEndpoint)) {
      pushAlert(state, config, broadcast, {
        severity: "CRITICAL",
        rule: "ENDPOINT_DRIFT",
        ip,
        identity,
        at: new Date().toISOString(),
        detail: `Attempted target endpoint ${targetEndpoint}`,
      });

      return deny(reply, {
        reason: "ENDPOINT_DRIFT",
        statusCode: 403,
        ip,
        endpoint,
        method,
        identity,
        payloadSize,
        latencyMs: Date.now() - startedAt,
        requestBody,
      });
    }

    try {
      await billingClient.post(config.billingUrl, requestBody);
    } catch (error) {
      return deny(reply, {
        reason: "BILLING_FORWARD_FAILED",
        statusCode: 502,
        ip,
        endpoint,
        method,
        identity,
        payloadSize,
        latencyMs: Date.now() - startedAt,
        requestBody,
      });
    }

    const latencyMs = Date.now() - startedAt;

    await dbClient.query(
      `INSERT INTO requests (
        request_time,
        source_ip,
        endpoint,
        method,
        service_identity,
        status_code,
        latency_ms,
        payload_size,
        verdict,
        reason,
        request_body
      ) VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        ip,
        endpoint,
        method,
        identity,
        200,
        latencyMs,
        payloadSize,
        "ALLOW",
        "OK",
        JSON.stringify(requestBody),
      ]
    );

    state.stats.allow += 1;

    const event = {
      type: "request",
      verdict: "ALLOW",
      reason: "OK",
      ip,
      endpoint,
      method,
      identity,
      statusCode: 200,
      latencyMs,
      at: new Date().toISOString(),
    };

    addRecentEvent(state, config, event);
    broadcast({ type: "request", ip, status: "ALLOW", reason: "OK" });

    return {
      ok: true,
      verdict: "ALLOW",
      reason: "OK",
    };
  });

  return app;
}

module.exports = {
  buildApp,
  loadConfigFromEnv,
  createState,
};
