require("dotenv").config();

const axios = require("axios");
const WebSocket = require("ws");
const { Client } = require("pg");
const Redis = require("ioredis");

const { buildApp, loadConfigFromEnv } = require("./app");

const config = loadConfigFromEnv();

let wss;

const dbClient = new Client({
  user: process.env.POSTGRES_USER || "siip",
  host: process.env.POSTGRES_HOST || "127.0.0.1",
  database: process.env.POSTGRES_DB || "siipdb",
  password: process.env.POSTGRES_PASSWORD || "siip",
  port: Number.parseInt(process.env.POSTGRES_PORT || "5433", 10),
});

const redisClient = new Redis(process.env.REDIS_URL || undefined);

function broadcast(payload) {
  if (!wss) {
    return;
  }

  const data = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

const app = buildApp({
  config,
  dbClient,
  redisClient,
  billingClient: axios,
  broadcast,
});

async function start() {
  try {
    await dbClient.connect();
    await app.ensureSchema();
    await app.listen({
      port: config.backendPort,
      host: "0.0.0.0",
    });

    // Share the same HTTP server port so WebSocket works on PaaS hosts.
    wss = new WebSocket.Server({ server: app.server });
    wss.on("connection", () => {
      console.log("WebSocket client connected");
    });

    console.log(`Backend listening on port ${config.backendPort}`);
    console.log(`WebSocket listening on port ${config.backendPort}`);
  } catch (error) {
    console.error("Startup failed", error);
    process.exit(1);
  }
}

start();