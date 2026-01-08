
// server.js (Node.js + ws) — OCPP 1.6J Gateway + Base44
// - WebSocket: wss://HOST/{chargePointId}
// - Healthcheck: GET /monitor
// - Root: GET /
// - List clients: GET /ocpp/clients
// - Base44 -> Node send command: POST /ocpp/send (x-api-key opcional)
// - Notifica Base44: CONNECTED / DISCONNECTED / HEARTBEAT / LASTSEEN

import http from "node:http";
import { WebSocketServer } from "ws";

process.on("uncaughtException", (err) => console.error("UNCAUGHT EXCEPTION:", err));
process.on("unhandledRejection", (err) => console.error("UNHANDLED REJECTION:", err));

const PORT = process.env.PORT || 3000;

// Base44 endpoints
const BASE44_OCPP_URL =
  process.env.BASE44_OCPP_URL ||
  process.env.BASE44_URL || // compat
  "https://targetecomobi.base44.app/api/functions/processOcppMessage";

const BASE44_STATUS_URL =
  process.env.BASE44_STATUS_URL || // opcional: se não definir, usa o OCPP_URL
  BASE44_OCPP_URL;

// Segurança para /ocpp/send
const API_KEY = process.env.API_KEY || "";

// Timeouts
const BASE44_TIMEOUT_MS = Number(process.env.BASE44_TIMEOUT_MS || 8000);

// Subprotocol OCPP
const REQUIRE_OCPP_SUBPROTOCOL =
  String(process.env.REQUIRE_OCPP_SUBPROTOCOL || "false") === "true";

// Ping/pong
const ENABLE_PING = String(process.env.ENABLE_PING || "true") === "true";
const PING_INTERVAL_MS = Number(process.env.PING_INTERVAL_MS || 30000);

const OCPP = { CALL: 2, CALLRESULT: 3, CALLERROR: 4 };

// chargePointId -> ws
const clients = new Map();
// messageId -> { chargePointId, action, createdAt }
const pendingRequests = new Map();
// chargePointId -> timestamp lastSeen
const lastSeen = new Map();

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
    console.warn("[Base44] URL undefined. Pulando envio.");
    return { ok: false, status: 0, json: null, text: "URL undefined" };
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

// ---- Notificações “online/offline” para Base44 ----
async function notifyBase44Status(event, serialNumber, extra = {}) {
  return postJson(BASE44_OCPP_URL, {
    serialNumber,
    message: {
      event,
      ts: nowIso(),
      ...extra
    }
  });
}

// ---- Forward OCPP para Base44 (mensagens) ----
async function forwardOcppToBase44({ serialNumber, raw, messageType }) {
  return postJson(BASE44_OCPP_URL, {
    serialNumber,
    message: raw,        // 🔥 manda o array OCPP completo
    messageType          // opcional (se quiser logar)
  });
}

// ---- Respostas padrão OCPP (fallback) ----
function buildCallResultFallback(action) {
  switch (action) {
    case "BootNotification":
      return { status: "Accepted", currentTime: nowIso(), interval: 300 };
    case "Heartbeat":
      return { currentTime: nowIso() };
    case "Authorize":
      return { idTagInfo: { status: "Accepted" } };
    case "StartTransaction":
      return {
        transactionId: Math.floor(Math.random() * 1e9),
        idTagInfo: { status: "Accepted" },
      };
    case "StopTransaction":
      return { idTagInfo: { status: "Accepted" } };
    case "DataTransfer":
      return { status: "Accepted" };
    default:
      return {};
  }
}

// ---- Enviar comando do servidor para o carregador (OCPP CALL) ----
function sendOcppCall(ws, chargePointId, action, payload = {}) {
  const messageId = uid();
  const msg = [OCPP.CALL, messageId, action, payload];

  pendingRequests.set(messageId, { chargePointId, action, createdAt: Date.now() });
  ws.send(JSON.stringify(msg));

  // opcional: registrar comando enviado ao Base44
  forwardOcppToBase44({
    chargePointId,
    direction: "FROM_SERVER",
    ocppType: "CALL",
    messageId,
    action,
    payload,
    raw: msg,
  }).catch(() => {});

  return messageId;
}

// ---- HTTP server ----
const server = http.createServer(async (req, res) => {
  // Root
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("OCPP 1.6J Gateway OK");
  }

  // Healthcheck
  if (req.method === "GET" && req.url === "/monitor") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, ts: nowIso() }));
  }

  // List online clients
  if (req.method === "GET" && req.url === "/ocpp/clients") {
    const list = [...clients.keys()].map((id) => ({
      chargePointId: id,
      lastSeenTs: lastSeen.get(id) || null,
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, count: list.length, clients: list, ts: nowIso() }));
  }

  // Base44 -> Node send command
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

    const { chargePointId, action, payload } = json || {};
    if (!chargePointId || !action) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "chargePointId and action are required" }));
    }

    const ws = clients.get(chargePointId);
    if (!ws || ws.readyState !== ws.OPEN) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "chargePoint offline" }));
    }

    const messageId = sendOcppCall(ws, chargePointId, action, payload || {});
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, messageId }));
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

// ---- WebSocket server ----
const wss = new WebSocketServer({
  server,
  handleProtocols: (protocols) => {
    const list = protocols instanceof Set ? [...protocols] : protocols || [];
    if (list.includes("ocpp1.6")) return "ocpp1.6";
    if (!REQUIRE_OCPP_SUBPROTOCOL && list.length) return list[0];
    return undefined;
  },
});

wss.on("connection", (ws, req) => {
  const chargePointId = (req.url || "/").replace("/", "") || "UNKNOWN";
  clients.set(chargePointId, ws);
  lastSeen.set(chargePointId, Date.now());

  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  console.log("[WS] conectado:", chargePointId);

  // Notifica Base44: conectado/online
  notifyBase44Status("CP_CONNECTED", chargePointId, {
    ip: req.socket?.remoteAddress || null,
    ua: req.headers["user-agent"] || null,
  }).catch(() => {});

  ws.on("message", async (data) => {
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

    // ---------------- CP -> SERVER (CALL) ----------------
    if (messageTypeId === OCPP.CALL) {
      const messageId = msg[1];
      const action = msg[2];
      const payload = msg[3] ?? {};

      lastSeen.set(chargePointId, Date.now());

      // Notifica Base44 “last seen”
      notifyBase44Status("CP_LASTSEEN", chargePointId, { action }).catch(() => {});

      // Se for Heartbeat, notificar explicitamente
      if (action === "Heartbeat") {
        notifyBase44Status("CP_HEARTBEAT", chargePointId).catch(() => {});
      }

      // 1) Você pode deixar o Base44 decidir a resposta:
      // const r = await forwardOcppToBase44(...); const callResult = r.json?.callResult ?? fallback;
      // 2) Ou responder rápido com fallback e apenas logar no Base44 (mais estável).
      const callResult = buildCallResultFallback(action);
      ws.send(JSON.stringify([OCPP.CALLRESULT, messageId, callResult]));

      // Loga a mensagem no Base44 (sem bloquear a resposta OCPP)
      forwardOcppToBase44({
        chargePointId,
        direction: "FROM_CP",
        ocppType: "CALL",
        messageId,
        action,
        payload,
        raw: msg,
      }).catch(() => {});

      return;
    }

    // ---------------- CP -> SERVER (CALLRESULT) ----------------
    if (messageTypeId === OCPP.CALLRESULT) {
      const messageId = msg[1];
      const payload = msg[2] ?? {};

      const pending = pendingRequests.get(messageId);
      if (pending) pendingRequests.delete(messageId);

      lastSeen.set(chargePointId, Date.now());
      notifyBase44Status("CP_LASTSEEN", chargePointId, { action: "CALLRESULT" }).catch(() => {});

      // envia resultado ao Base44
      forwardOcppToBase44({
        chargePointId,
        direction: "FROM_CP",
        ocppType: "CALLRESULT",
        messageId,
        action: pending?.action || null,
        payload,
        raw: msg,
        extra: { pendingAction: pending?.action || null },
      }).catch(() => {});

      return;
    }

    // ---------------- CP -> SERVER (CALLERROR) ----------------
    if (messageTypeId === OCPP.CALLERROR) {
      const messageId = msg[1];
      const errorCode = msg[2];
      const errorDescription = msg[3];
      const errorDetails = msg[4] ?? {};

      const pending = pendingRequests.get(messageId);
      if (pending) pendingRequests.delete(messageId);

      lastSeen.set(chargePointId, Date.now());
      notifyBase44Status("CP_LASTSEEN", chargePointId, { action: "CALLERROR" }).catch(() => {});

      forwardOcppToBase44({
        chargePointId,
        direction: "FROM_CP",
        ocppType: "CALLERROR",
        messageId,
        action: pending?.action || null,
        payload: { errorCode, errorDescription, errorDetails },
        raw: msg,
        extra: { pendingAction: pending?.action || null },
      }).catch(() => {});

      return;
    }

    console.warn("[WS] MessageTypeId desconhecido:", msg);
  });

  ws.on("close", () => {
    clients.delete(chargePointId);
    console.log("[WS] desconectado:", chargePointId);

    notifyBase44Status("CP_DISCONNECTED", chargePointId).catch(() => {});
  });

  ws.on("error", (err) => {
    console.warn("[WS] erro:", chargePointId, err);
  });
});

// ---- Ping/pong watchdog (opcional) ----
if (ENABLE_PING) {
  setInterval(() => {
    for (const [cpId, ws] of clients.entries()) {
      if (ws.isAlive === false) {
        try {
          ws.terminate();
        } catch {}
        clients.delete(cpId);
        notifyBase44Status("CP_DISCONNECTED", cpId, { reason: "ping_timeout" }).catch(() => {});
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {}
    }
  }, PING_INTERVAL_MS);
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`OCPP Gateway rodando na porta ${PORT}`);
  console.log(`Healthcheck: /monitor`);
});

