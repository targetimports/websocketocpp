// server.js — OCPP 1.6J Gateway (Node.js)
// Compatível com Railway + Base44

import http from "node:http";
import { WebSocketServer } from "ws";

/* ===================== CONFIG ===================== */

const PORT = process.env.PORT || 3000;
const BASE44_URL =
  process.env.BASE44_URL ||
  "https://targetecomobi.base44.app/api/functions/processOcppMessage";

const HEARTBEAT_INTERVAL_SEC = Number(process.env.HEARTBEAT_INTERVAL_SEC || 30);
const API_KEY = process.env.API_KEY || "";

/* ===================== OCPP CONST ===================== */

const OCPP = {
  CALL: 2,
  CALLRESULT: 3,
  CALLERROR: 4,
};

/* ===================== STATE ===================== */

const clients = new Map();          // serialNumber -> ws
const hbTimers = new Map();         // serialNumber -> interval
const pendingHealth = new Map();    // messageId -> resolver

/* ===================== UTILS ===================== */

function nowIso() {
  return new Date().toISOString();
}

function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

async function sendToBase44(serialNumber, message) {
  try {
    await fetch(BASE44_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serialNumber, message }),
    });
  } catch (e) {
    console.warn("[Base44] erro:", e.message);
  }
}

/* ===================== OCPP HELPERS ===================== */

async function notifyConnected(serialNumber) {
  return sendToBase44(serialNumber, [
    OCPP.CALL,
    `conn-${Date.now()}`,
    "StatusNotification",
    {
      connectorId: 0,
      status: "Available",
      errorCode: "NoError",
      timestamp: nowIso(),
    },
  ]);
}

async function notifyDisconnected(serialNumber) {
  return sendToBase44(serialNumber, [
    OCPP.CALL,
    `disc-${Date.now()}`,
    "StatusNotification",
    {
      connectorId: 0,
      status: "Unavailable",
      errorCode: "NoError",
      timestamp: nowIso(),
    },
  ]);
}

async function sendHeartbeatToBase44(serialNumber) {
  return sendToBase44(serialNumber, [
    OCPP.CALL,
    `hb-${Date.now()}`,
    "Heartbeat",
    {},
  ]);
}

function waitForHealthResponse(messageId, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pendingHealth.delete(messageId);
      reject(new Error("timeout"));
    }, timeoutMs);

    pendingHealth.set(messageId, () => {
      clearTimeout(t);
      resolve();
    });
  });
}

/* ===================== HTTP SERVER ===================== */

const server = http.createServer(async (req, res) => {
  console.log("HTTP:", req.method, req.url);

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200);
    return res.end("OCPP Gateway OK");
  }

  if (req.method === "GET" && req.url === "/monitor") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, ts: nowIso() }));
  }

  if (req.method === "GET" && req.url === "/ocpp/clients") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      ok: true,
      clients: [...clients.keys()],
      count: clients.size,
    }));
  }

  // 🔥 Healthcheck REAL por carregador
  if (req.method === "GET" && req.url.startsWith("/ocpp/health/")) {
    const serialNumber = req.url.split("/").pop();
    const ws = clients.get(serialNumber);

    if (!ws || ws.readyState !== ws.OPEN) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        serialNumber,
        online: false,
        reason: "ws_not_connected",
      }));
    }

    const messageId = uid();
    ws.send(JSON.stringify([OCPP.CALL, messageId, "Heartbeat", {}]));

    try {
      await waitForHealthResponse(messageId, 5000);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        serialNumber,
        online: true,
        checkedAt: nowIso(),
      }));
    } catch {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        serialNumber,
        online: false,
        reason: "no_heartbeat_response",
      }));
    }
  }

  // Enviar comando OCPP via HTTP
  if (req.method === "POST" && req.url === "/ocpp/send") {
    if (API_KEY && req.headers["x-api-key"] !== API_KEY) {
      res.writeHead(401);
      return res.end("unauthorized");
    }

    const body = JSON.parse(await readBody(req));
    const { serialNumber, action, payload } = body;

    const ws = clients.get(serialNumber);
    if (!ws || ws.readyState !== ws.OPEN) {
      res.writeHead(404);
      return res.end("charger offline");
    }

    ws.send(JSON.stringify([OCPP.CALL, uid(), action, payload || {}]));
    res.writeHead(200);
    return res.end(JSON.stringify({ ok: true }));
  }

  res.writeHead(404);
  res.end("not found");
});

/* ===================== WEBSOCKET SERVER ===================== */

const wss = new WebSocketServer({
  server,
  handleProtocols: (protocols) =>
    protocols.has("ocpp1.6") ? "ocpp1.6" : false,
});

wss.on("connection", (ws, req) => {
  const serialNumber = (req.url || "/").replace("/", "");

  if (!/^[0-9]{6,}$/.test(serialNumber)) {
    ws.close();
    return;
  }

  clients.set(serialNumber, ws);
  console.log("[WS] conectado:", serialNumber);

  notifyConnected(serialNumber);

  const hbTimer = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      sendHeartbeatToBase44(serialNumber);
    }
  }, HEARTBEAT_INTERVAL_SEC * 1000);

  hbTimers.set(serialNumber, hbTimer);

  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    const messageTypeId = msg[0];

    if (messageTypeId === OCPP.CALLRESULT) {
      const messageId = msg[1];
      const resolver = pendingHealth.get(messageId);
      if (resolver) {
        pendingHealth.delete(messageId);
        resolver();
      }
      sendToBase44(serialNumber, msg);
    }

    if (messageTypeId === OCPP.CALL) {
      const [_, messageId, action] = msg;
      let payload = {};

      if (action === "BootNotification") {
        payload = { status: "Accepted", currentTime: nowIso(), interval: HEARTBEAT_INTERVAL_SEC };
      } else if (action === "Heartbeat") {
        payload = { currentTime: nowIso() };
      }

      ws.send(JSON.stringify([OCPP.CALLRESULT, messageId, payload]));
      sendToBase44(serialNumber, msg);
    }
  });

  ws.on("close", () => {
    console.log("[WS] desconectado:", serialNumber);
    clearInterval(hbTimers.get(serialNumber));
    hbTimers.delete(serialNumber);
    clients.delete(serialNumber);
    notifyDisconnected(serialNumber);
  });
});

/* ===================== START ===================== */

server.listen(PORT, "0.0.0.0", () => {
  console.log("OCPP Gateway rodando na porta", PORT);
});
