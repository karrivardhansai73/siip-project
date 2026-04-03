const express = require("express");
const app = express();
const crmPort = Number.parseInt(process.env.CRM_PORT || "4000", 10);

const validToken = require("jsonwebtoken").sign({ user: "crm" }, "secret");
const apiKey = process.env.CRM_API_KEY || "student-dev-key";

app.get("/favicon.ico", (req, res) => {
  res.status(204).end();
});

app.get("/", (req, res) => {
  res.send(`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>SIIP Lite CRM Console</title>
        <style>
          :root {
            --bg: #f5f7ef;
            --card: #ffffff;
            --ink: #111827;
            --muted: #4b5563;
            --ok: #157f3b;
            --deny: #b42318;
            --warn: #9c5a00;
            --edge: #d4d4d8;
          }
          * { box-sizing: border-box; }
          body {
            margin: 0;
            font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
            color: var(--ink);
            background: radial-gradient(circle at 20% 20%, #dce9ff, transparent 40%),
                        radial-gradient(circle at 80% 10%, #fde9c9, transparent 35%),
                        var(--bg);
            min-height: 100vh;
            padding: 24px;
          }
          .wrap {
            max-width: 1024px;
            margin: 0 auto;
          }
          h1 {
            margin: 0 0 6px 0;
            font-size: 30px;
          }
          .sub {
            color: var(--muted);
            margin-bottom: 18px;
          }
          .grid {
            display: grid;
            gap: 14px;
          }
          .stats {
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
          }
          .card {
            background: var(--card);
            border: 1px solid var(--edge);
            border-radius: 14px;
            padding: 14px;
            box-shadow: 0 6px 24px rgba(0, 0, 0, 0.06);
          }
          .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
          .value { font-size: 28px; font-weight: 700; margin-top: 2px; }
          .actions {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
            margin: 14px 0;
          }
          button {
            border: 0;
            border-radius: 10px;
            padding: 11px 14px;
            cursor: pointer;
            font-weight: 600;
          }
          .ok { background: #daf8e6; color: #0d5f2f; }
          .bad { background: #ffe2dd; color: #8f2313; }
          .flood { background: #ffeec8; color: #7f4f00; }
          table {
            width: 100%;
            border-collapse: collapse;
            font-size: 13px;
          }
          th, td {
            text-align: left;
            padding: 8px;
            border-bottom: 1px solid #ececf1;
          }
          .pill { padding: 2px 8px; border-radius: 999px; font-size: 12px; }
          .allow { background: #d8f7e4; color: var(--ok); }
          .deny { background: #ffe1e0; color: var(--deny); }
          .status {
            font-size: 12px;
            color: var(--muted);
            margin-top: 8px;
          }
          .alerts {
            max-height: 180px;
            overflow: auto;
          }
          .alert-row {
            font-size: 13px;
            padding: 6px 0;
            border-bottom: 1px dashed #ececf1;
          }
          @media (max-width: 720px) {
            body { padding: 14px; }
            .value { font-size: 24px; }
          }
        </style>
      </head>
      <body>
        <div class="wrap">
          <h1>SIIP Lite CRM Console</h1>
          <div class="sub">Live traffic and security events from backend WebSocket stream</div>

          <div class="grid stats">
            <div class="card"><div class="label">Allow</div><div id="allowCount" class="value">0</div></div>
            <div class="card"><div class="label">Deny</div><div id="denyCount" class="value">0</div></div>
            <div class="card"><div class="label">Rate Limit</div><div id="rateCount" class="value">0</div></div>
            <div class="card"><div class="label">Alerts</div><div id="alertCount" class="value">0</div></div>
          </div>

          <div class="actions">
            <button class="ok" onclick="sendValid()">Send Valid Request</button>
            <button class="bad" onclick="sendInvalid()">Send Invalid Token</button>
            <button class="flood" onclick="sendFlood()">Flood 10 Requests</button>
          </div>
          <div id="status" class="status">Waiting for action...</div>

          <div class="card" style="margin-top: 12px;">
            <div class="label">Recent Security Alerts</div>
            <div id="alerts" class="alerts"></div>
          </div>

          <div class="card" style="margin-top: 12px; overflow-x:auto;">
            <div class="label">Recent Request Events</div>
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>IP</th>
                  <th>Status</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody id="eventsBody"></tbody>
            </table>
          </div>
        </div>

        <script>
          const counters = { allow: 0, deny: 0, rate: 0, alerts: 0 };
          const rows = [];

          function updateCounters() {
            document.getElementById("allowCount").textContent = counters.allow;
            document.getElementById("denyCount").textContent = counters.deny;
            document.getElementById("rateCount").textContent = counters.rate;
            document.getElementById("alertCount").textContent = counters.alerts;
          }

          function addEvent(event) {
            rows.unshift(event);
            if (rows.length > 50) rows.length = 50;

            const body = document.getElementById("eventsBody");
            body.innerHTML = rows.map((row) => {
              const status = row.status || row.verdict || "UNKNOWN";
              const cls = status === "ALLOW" ? "allow" : "deny";
              return '<tr>'
                + '<td>' + new Date().toLocaleTimeString() + '</td>'
                + '<td>' + (row.ip || '-') + '</td>'
                + '<td><span class="pill ' + cls + '">' + status + '</span></td>'
                + '<td>' + (row.reason || 'OK') + '</td>'
                + '</tr>';
            }).join("");
          }

          function addAlert(alert) {
            const host = document.getElementById("alerts");
            const row = document.createElement("div");
            row.className = "alert-row";
            row.textContent = "[" + (alert.severity || "INFO") + "] " + (alert.rule || "ALERT") + " - " + (alert.detail || "");
            host.prepend(row);
            while (host.childElementCount > 12) {
              host.removeChild(host.lastChild);
            }
          }

          async function postWebhook(token, payload) {
            try {
              const res = await fetch("http://localhost:3000/webhook", {
                method: "POST",
                headers: {
                  "Authorization": token,
                  "x-api-key": "${apiKey}",
                  "Content-Type": "application/json"
                },
                body: JSON.stringify(payload)
              });
              const json = await res.json();
              document.getElementById("status").textContent = "HTTP " + res.status + ": " + (json.reason || json.message || json.verdict);
            } catch (error) {
              document.getElementById("status").textContent = "Request failed: " + error.message;
            }
          }

          async function sendValid() {
            await postWebhook("${validToken}", { amount: 500, customer: "John", targetEndpoint: "/receive" });
          }

          async function sendInvalid() {
            await postWebhook("wrongtoken", { amount: 500, customer: "John", targetEndpoint: "/receive" });
          }

          async function sendFlood() {
            for (let i = 0; i < 10; i += 1) {
              postWebhook("${validToken}", { amount: i, customer: "Flood", targetEndpoint: "/receive" });
            }
          }

          const ws = new WebSocket("ws://localhost:8080");
          ws.onopen = () => {
            document.getElementById("status").textContent = "WebSocket connected";
          };
          ws.onmessage = (message) => {
            const data = JSON.parse(message.data);
            if (data.type === "request") {
              if (data.status === "ALLOW") counters.allow += 1;
              else counters.deny += 1;
              if (data.reason === "RATE_LIMIT") counters.rate += 1;
              addEvent(data);
              updateCounters();
            }
            if (data.type === "alert") {
              counters.alerts += 1;
              addAlert(data);
              updateCounters();
            }
          };
          ws.onerror = () => {
            document.getElementById("status").textContent = "WebSocket connection failed";
          };

          updateCounters();
        </script>
      </body>
    </html>
  `);
});

app.listen(crmPort, () => {
  console.log(`CRM UI running at http://localhost:${crmPort}`);
});