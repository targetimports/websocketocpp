// server.js — OCPP 1.6J Gateway (Node.js) + Base44
// ✅ WSS OCPP 1.6 (subprotocol ocpp1.6)
// ✅ /monitor (health do serviço)
// ✅ /ocpp/clients (lista conectados)
// ✅ /ocpp/health/:serial (health REAL por WS ping/pong)
// ✅ /ocpp/send (HTTP -> envia CALL OCPP ao carregador)
// ✅ on connection -> StatusNotification Available (para Base44)
// ✅ on close -> StatusNotification Unavailable (para Base44)
// ✅ Heartbeat automático (envia para Base44 para manter last_heartbeat)
//
// ENV:
// - PORT
// - BASE44_URL (https://.../api/functions/processOcppMessage)
// - API_KEY (opcional, protege /ocpp/send)
// - HEARTBEAT_INTERVAL_SEC (default 30)

import http from "node:http";
import { WebSocketServer } from "ws";

/* ===================== CONFIG ===================== */

const PORT = Number(process.env.PORT || 3000);
const BASE44_URL =
  process.env.BASE44_URL ||
  "https://targetecomobi.base44.app/api/functions/processOcppMessage";

const API_KEY = process.env.API_KEY || "";
const HEARTBEAT_INTERVAL_SEC = Number(process.env.HEARTBEAT_INTERVAL_SEC || 30);
const BASE44_TIMEOUT_MS = Number(process.env.BASE44_TIMEOUT_MS || 8000);

/* ===================== OCPP ===================== */

const OCPP = { CALL: 2, CALLRESULT: 3, CALLERROR: 4 };

/* ===================== STATE ===================== */

const clients = new Map();   // serialNumber -> ws
const hbTimers = new Map();  // serialNumber -> intervalId

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

async function postJson(url, body) {
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
    try { json = JSON.parse(text); } catch {}

    return { ok: res.ok, status: res.status, json, text };
  } catch (e) {
    return { ok: false, status: 0, json: null, text: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

async function sendToBase44(serialNumber, messageArray) {
  if (!BASE44_URL) return;
  const r = await postJson(BASE44_URL, { serialNumber, message: messageArray });
  if (!r.ok) console.warn("[Base44] falha:", r.status, r.text);
  return r;
}

/* ===================== OCPP -> Base44 (status via OCPP válido) ===================== */

function msgStatus(serialNumber, status, info) {
  return [
    OCPP.CALL,
    `${status.toLowerCase()}-${Date.now()}`,
    "StatusNotification",
    {
      connectorId: 0,
      status,                 // "Available" | "Unavailable"
      errorCode: "NoError",
      info: info || undefined,
      timestamp: nowIso(),
    },
  ];
}

function msgHeartbeat() {
  return [OCPP.CALL, `hb-${Date.now()}`, "Heartbeat", {}];
}

async function notifyConnected(serialNumber) {
  return sendToBase44(serialNumber, msgStatus(serialNumber, "Available", "WS Connected"));
}

async function notifyDisconnected(serialNumber) {
  return sendToBase44(serialNumber, msgStatus(serialNumber, "Unavailable", "WS Disconnected"));
}

/* ===================== HEALTH (WS ping/pong) ===================== */

function waitForPong(ws, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.off("pong", onPong);
      reject(new Error("pong_timeout"));
    }, timeoutMs);

    function onPong() {
      clearTimeout(t);
      ws.off("pong", onPong);
      resolve();
    }

    ws.on("pong", onPong);

    try {
      ws.ping();
    } catch (e) {
      clearTimeout(t);
      ws.off("pong", onPong);
      reject(e);
    }
  });
}

/* ===================== SEND OCPP CALL (HTTP -> Charger) ===================== */

function sendOcppCallToCharger(ws, action, payload = {}) {
  const messageId = uid();
  ws.send(JSON.stringify([OCPP.CALL, messageId, action, payload]));
  return messageId;
}

/* ===================== HTTP SERVER ===================== */

const server = http.createServer(async (req, res) => {
  console.log("HTTP:", req.method, req.url);

  // /
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("OCPP 1.6J Gateway OK");
  }

  // /monitor
  if (req.method === "GET" && req.url === "/monitor") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, ts: nowIso() }));
  }

  // /ocpp/clients
  if (req.method === "GET" && req.url === "/ocpp/clients") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      ok: true,
      count: clients.size,
      clients: [...clients.keys()],
      ts: nowIso(),
    }));
  }

  // ✅ /ocpp/health/:serial (WS ping/pong)
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

    try {
      await waitForPong(ws, 3000);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        serialNumber,
        online: true,
        checkedAt: nowIso(),
        method: "ws_ping",
      }));
    } catch {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        serialNumber,
        online: false,
        reason: "pong_timeout",
        checkedAt: nowIso(),
        method: "ws_ping",
      }));
    }
  }

  // ✅ /ocpp/send  (HTTP -> envia comando ao carregador)
  if (req.method === "POST" && req.url === "/ocpp/send") {
    if (API_KEY && req.headers["x-api-key"] !== API_KEY) {
      res.writeHead(401, { "Content-Type": "text/plain" });
      return res.end("unauthorized");
    }

    let json;
    try {
      json = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
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

    const messageId = sendOcppCallToCharger(ws, action, payload || {});
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, messageId }));
  }

  // 404
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

/* ===================== WEBSOCKET SERVER ===================== */

const wss = new WebSocketServer({
  server,
  // ✅ aceita subprotocol ocpp1.6 (muitos carregadores exigem)
  handleProtocols: (protocols) => {
    const list = protocols instanceof Set ? [...protocols] : protocols || [];
    if (list.includes("ocpp1.6")) return "ocpp1.6";
    return false;
  },
});

wss.on("connection", (ws, req) => {
  const serialNumber = (req.url || "/").replace("/", "").trim() || "UNKNOWN";

  // bloqueia caminhos errados (ex.: /monitor por WS)
  if (serialNumber === "monitor" || serialNumber === "UNKNOWN" || serialNumber === "") {
    console.warn("[WS] ignorado path inválido:", req.url);
    try { ws.close(); } catch {}
    return;
  }

  // ajuste se seus seriais tiverem letras:
  if (!/^\d{6,}$/.test(serialNumber)) {
    console.warn("[WS] serial inválido:", serialNumber, "url:", req.url);
    try { ws.close(); } catch {}
    return;
  }

  clients.set(serialNumber, ws);
  console.log("[WS] conectado:", serialNumber);

  // notifica Base44 como "online"
  notifyConnected(serialNumber).catch(() => {});

  // Heartbeat automático para Base44 (mantém last_heartbeat vivo)
  const timer = setInterval(() => {
    const current = clients.get(serialNumber);
    if (!current || current.readyState !== current.OPEN) return;
    sendToBase44(serialNumber, msgHeartbeat()).catch(() => {});
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

      // ✅ responder rápido (não esperar Base44)
      let respPayload = {};
      if (action === "BootNotification") {
        respPayload = { status: "Accepted", currentTime: nowIso(), interval: HEARTBEAT_INTERVAL_SEC };
      } else if (action === "Heartbeat") {
        respPayload = { currentTime: nowIso() };
      } else {
        respPayload = {};
      }

      try {
        ws.send(JSON.stringify([OCPP.CALLRESULT, messageId, respPayload]));
      } catch (e) {
        console.warn("[WS] falha ao responder CALLRESULT:", e.message);
      }

      // log no Base44
      sendToBase44(serialNumber, msg).catch(() => {});
      return;
    }

    // CP -> Server (CALLRESULT / CALLERROR): apenas log no Base44
    if (messageTypeId === OCPP.CALLRESULT || messageTypeId === OCPP.CALLERROR) {
      sendToBase44(serialNumber, msg).catch(() => {});
      return;
    }
  });

  ws.on("close", () => {
    console.log("[WS] desconectado:", serialNumber);

    const t = hbTimers.get(serialNumber);
    if (t) clearInterval(t);
    hbTimers.delete(serialNumber);

    clients.delete(serialNumber);

    // notifica Base44 como offline
    notifyDisconnected(serialNumber).catch(() => {});
  });

  ws.on("error", (err) => {
    console.warn("[WS] erro:", serialNumber, err?.message || err);
  });
});

/* ===================== START ===================== */

server.listen(PORT, "0.0.0.0", () => {
  console.log("OCPP Gateway rodando na porta " + PORT);
  console.log("Health geral: /monitor");
  console.log("Health por carregador: /ocpp/health/:serial");
});
