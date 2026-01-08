
// server.js (Node.js + ws) — OCPP 1.6J Gateway + Base44
// ✅ on connection: envia StatusNotification (Available) pro Base44 no formato que sua function aceita
// ✅ on close: envia StatusNotification (Unavailable) pro Base44
// ✅ heartbeat automático (OCPP Heartbeat) enquanto conectado
//
// WebSocket: wss://HOST/{serialNumber}
// Healthcheck: GET /monitor
// Root: GET /
// List: GET /ocpp/clients
// Base44 -> Node send command: POST /ocpp/send  (x-api-key opcional)
//
// ENV:
// - PORT
// - BASE44_URL  (https://.../api/functions/processOcppMessage)
// - API_KEY (opcional p/ /ocpp/send)
// - HEARTBEAT_INTERVAL_SEC (opcional, default 30)

import http from "node:http";
import { WebSocketServer } from "ws";

process.on("uncaughtException", (err) => console.error("UNCAUGHT EXCEPTION:", err));
process.on("unhandledRejection", (err) => console.error("UNHANDLED REJECTION:", err));

const PORT = process.env.PORT || 3000;

const BASE44_URL =
  process.env.BASE44_URL ||
  "https://targetecomobi.base44.app/api/functions/processOcppMessage";

const API_KEY = process.env.API_KEY || "";

const HEARTBEAT_INTERVAL_SEC = Number(process.env.HEARTBEAT_INTERVAL_SEC || 30);
const BASE44_TIMEOUT_MS = Number(process.env.BASE44_TIMEOUT_MS || 8000);

const OCPP = { CALL: 2, CALLRESULT: 3, CALLERROR: 4 };

// serialNumber -> ws
const clients = new Map();
// serialNumber -> heartbeat timer
const hbTimers = new Map();
// messageId -> { serialNumber, action, createdAt }
const pendingRequests = new Map();

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

async function postJson(url, body) {
  if (!url) {
    console.warn("[Base44] BASE44_URL vazio/undefined. Pulando envio.");
    return { ok: false, status: 0, json: null, text: "BASE44_URL undefined" };
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), BASE44_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify(body),
    });

    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}

    return { ok: res.ok, status: res.status, json, text };
  } catch (e) {
    return { ok: false, status: 0, json: null, text: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

// ✅ Envia para sua function Base44 exatamente como ela espera: { serialNumber, message: [ ...OCPP array... ] }
async function sendToBase44(serialNumber, messageArray) {
  const r = await postJson(BASE44_URL, {
    serialNumber,
    message: messageArray,
  });

  if (!r.ok) {
    console.warn("[Base44] falha:", r.status, r.text);
  }
  return r;
}

// ✅ Evento "online" via StatusNotification OCPP válido
async function notifyConnected(serialNumber) {
  const msg = [
    OCPP.CALL,
    `conn-${Date.now()}`,
    "StatusNotification",
    {
      connectorId: 0,
      status: "Available",
      errorCode: "NoError",
      timestamp: nowIso(),
    },
  ];
  await sendToBase44(serialNumber, msg);
}

// ✅ Evento "offline" via StatusNotification OCPP válido
async function notifyDisconnected(serialNumber, reason = "Disconnected") {
  const msg = [
    OCPP.CALL,
    `disc-${Date.now()}`,
    "StatusNotification",
    {
      connectorId: 0,
      status: "Unavailable",
      errorCode: "NoError",
      info: reason,
      timestamp: nowIso(),
    },
  ];
  await sendToBase44(serialNumber, msg);
}

// ✅ Heartbeat automático (OCPP válido) para manter last_heartbeat atualizado
async function sendHeartbeat(serialNumber) {
  const msg = [OCPP.CALL, `hb-${Date.now()}`, "Heartbeat", {}];
  await sendToBase44(serialNumber, msg);
}

// Comando do servidor para o carregador (OCPP CALL via WS)
function sendOcppCallToCharger(ws, serialNumber, action, payload = {}) {
  const messageId = uid();
  const msg = [OCPP.CALL, messageId, action, payload];

  pendingRequests.set(messageId, { serialNumber, action, createdAt: Date.now() });
  ws.send(JSON.stringify(msg));

  // também registra no Base44 como "ação enviada" (opcional)
  sendToBase44(serialNumber, msg).catch(() => {});

  return messageId;
}

// HTTP server
const server = http.createServer(async (req, res) => {

  // ROOT
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("OCPP 1.6J Gateway OK");
  }

  // MONITOR
  if (req.method === "GET" && req.url === "/monitor") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, ts: nowIso() }));
  }

  // CLIENTS
  if (req.method === "GET" && req.url === "/ocpp/clients") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      ok: true,
      clients: [...clients.keys()],
      count: clients.size
    }));
  }

  // 🔥 HEALTHCHECK POR CARREGADOR
  if (req.method === "GET" && req.url.startsWith("/ocpp/health/")) {
    const serialNumber = req.url.split("/").pop();

    const ws = clients.get(serialNumber);
    if (!ws || ws.readyState !== ws.OPEN) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        serialNumber,
        online: false,
        reason: "ws_not_connected"
      }));
    }

    try {
      const messageId = uid();
      const heartbeat = [OCPP.CALL, messageId, "Heartbeat", {}];

      ws.send(JSON.stringify(heartbeat));

      await waitForCallResult(messageId, 5000);

      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        serialNumber,
        online: true,
        checkedAt: nowIso()
      }));
    } catch {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        serialNumber,
        online: false,
        reason: "no_heartbeat_response"
      }));
    }
  }

  // 🔴 404 SEMPRE POR ÚLTIMO
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});


  // Base44 -> Node: enviar comando a qualquer momento
  if (req.method === "POST" && req.url === "/ocpp/send") {
    if (API_KEY && req.headers["x-api-key"] !== API_KEY) {
      res.writeHead(401);
      return res.end("unauthorized");
    }

    const body = await readBody(req);
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      res.writeHead(400);
      return res.end("invalid json");
    }

    const { serialNumber, action, payload } = json || {};
    if (!serialNumber || !action) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "serialNumber and action are required" }));
    }

    const ws = clients.get(serialNumber);
    if (!ws || ws.readyState !== ws.OPEN) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "charger offline" }));
    }

    const messageId = sendOcppCallToCharger(ws, serialNumber, action, payload || {});
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, messageId }));
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

// WS server (porta única do Railway)
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const serialNumber = (req.url || "/").replace("/", "") || "UNKNOWN";
  clients.set(serialNumber, ws);

  console.log("[WS] conectado:", serialNumber);

  // ✅ avisa Base44 que está online (via OCPP StatusNotification válido)
  notifyConnected(serialNumber).catch(() => {});

  // ✅ heartbeat automático (via Base44) enquanto estiver conectado
  const timer = setInterval(() => {
    const current = clients.get(serialNumber);
    if (!current || current.readyState !== current.OPEN) return;
    sendHeartbeat(serialNumber).catch(() => {});
  }, HEARTBEAT_INTERVAL_SEC * 1000);

  hbTimers.set(serialNumber, timer);

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.warn("[WS] JSON inválido:", data.toString());
      return;
    }

    // OCPP: [type, id, action?, payload?]
    if (!Array.isArray(msg) || msg.length < 2) {
      console.warn("[WS] formato inválido:", msg);
      return;
    }

    const messageTypeId = msg[0];

    // CP -> Server (CALL)
    if (messageTypeId === OCPP.CALL) {
      const messageId = msg[1];
      const action = msg[2];
      const payload = msg[3] ?? {};

      // responde rápido (fallback) — evita derrubar sessão
      let responsePayload = {};
      switch (action) {
        case "BootNotification":
          responsePayload = { status: "Accepted", currentTime: nowIso(), interval: HEARTBEAT_INTERVAL_SEC };
          break;
        case "Heartbeat":
          responsePayload = { currentTime: nowIso() };
          break;
        case "Authorize":
          responsePayload = { idTagInfo: { status: "Accepted" } };
          break;
        case "StartTransaction":
          responsePayload = {
            transactionId: Math.floor(Math.random() * 1e9),
            idTagInfo: { status: "Accepted" },
          };
          break;
        case "StopTransaction":
          responsePayload = { idTagInfo: { status: "Accepted" } };
          break;
        default:
          responsePayload = {};
      }

      ws.send(JSON.stringify([OCPP.CALLRESULT, messageId, responsePayload]));

      // envia mensagem original pro Base44 (formato aceito)
      sendToBase44(serialNumber, msg).catch(() => {});
      return;
    }

    // CP -> Server (CALLRESULT)
    if (messageTypeId === OCPP.CALLRESULT) {
      const messageId = msg[1];
      const payload = msg[2] ?? {};
      const pending = pendingRequests.get(messageId);
      if (pending) pendingRequests.delete(messageId);

      // envia pro Base44 (ele ignora se não for CALL, mas mantém log se quiser)
      sendToBase44(serialNumber, msg).catch(() => {});
      return;
    }

    // CP -> Server (CALLERROR)
    if (messageTypeId === OCPP.CALLERROR) {
      const messageId = msg[1];
      const pending = pendingRequests.get(messageId);
      if (pending) pendingRequests.delete(messageId);

      sendToBase44(serialNumber, msg).catch(() => {});
      return;
    }
  });

  ws.on("close", () => {
    console.log("[WS] desconectado:", serialNumber);

    // para heartbeat timer
    const t = hbTimers.get(serialNumber);
    if (t) clearInterval(t);
    hbTimers.delete(serialNumber);

    clients.delete(serialNumber);

    // ✅ avisa Base44 offline (via StatusNotification válido)
    notifyDisconnected(serialNumber).catch(() => {});
  });

  ws.on("error", (err) => {
    console.warn("[WS] erro:", serialNumber, err);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("OCPP Gateway rodando na porta " + PORT);
  console.log("Healthcheck: /monitor");
});

