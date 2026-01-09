/**
 * server.js — OCPP 1.6J Gateway (WS + HTTP) com:
 * - Respostas imediatas (CALLRESULT) para ações comuns (Boot/Heartbeat/Authorize/Start/Stop/Meter/DataTransfer)
 * - CALLERROR NotImplemented para ações desconhecidas (evita payload inválido)
 * - Fila de comandos "logo ao conectar" (enfileira no connect e dispara após BootNotification Accepted)
 * - perMessageDeflate desativado (compatibilidade)
 * - TCP keep-alive e ping opcional (para evitar timeout de proxy/LB)
 *
 * Rotas HTTP:
 *  GET  /monitor
 *  GET  /ocpp/clients
 *  POST /ocpp/send   (envia CALL do servidor -> carregador)
 *
 * ENV:
 *  PORT=3000
 *  BASE44_URL=https://.../processOcppMessage
 *  API_KEY=...
 *  BOOT_INTERVAL_SEC=30
 *  BASE44_HEARTBEAT_SEC=30
 *
 *  ENABLE_PING=false
 *  PING_INTERVAL_MS=20000
 *  TCP_KEEPALIVE_MS=15000
 *
 *  // comandos automáticos ao conectar (disparam após BootNotification)
 *  AUTO_TRIGGER_STATUS=true
 *  AUTO_TRIGGER_METER=false
 *  AUTO_TRIGGER_CONNECTOR_ID=1
 *  AUTO_DATATRANSFER=false
 *  AUTO_VENDOR_ID=SeuVendor
 *  AUTO_MESSAGE_ID=Hello
 *  AUTO_DATA=ping
 *
 *  // reserva automática (opcional)
 *  AUTO_RESERVE=false
 *  AUTO_RESERVE_CONNECTOR_ID=1
 *  AUTO_RESERVE_IDTAG=ABC123
 *  AUTO_RESERVE_MINUTES=30
 *  AUTO_RESERVE_RESERVATION_ID=101
 */

import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 3000);
const BASE44_URL =
  process.env.BASE44_URL ||
  "https://targetecomobi.base44.app/api/functions/processOcppMessage";
const API_KEY = process.env.API_KEY || "";

const BOOT_INTERVAL_SEC = Number(process.env.BOOT_INTERVAL_SEC || 30);
const BASE44_HEARTBEAT_SEC = Number(process.env.BASE44_HEARTBEAT_SEC || 30);

const ENABLE_PING = String(process.env.ENABLE_PING || "false") === "true";
const PING_INTERVAL_MS = Number(process.env.PING_INTERVAL_MS || 20000);
const TCP_KEEPALIVE_MS = Number(process.env.TCP_KEEPALIVE_MS || 15000);

// auto-commands
const AUTO_TRIGGER_STATUS = String(process.env.AUTO_TRIGGER_STATUS || "true") === "true";
const AUTO_TRIGGER_METER = String(process.env.AUTO_TRIGGER_METER || "false") === "true";
const AUTO_TRIGGER_CONNECTOR_ID = Number(process.env.AUTO_TRIGGER_CONNECTOR_ID || 1);

const AUTO_DATATRANSFER = String(process.env.AUTO_DATATRANSFER || "false") === "true";
const AUTO_VENDOR_ID = String(process.env.AUTO_VENDOR_ID || "SeuVendor");
const AUTO_MESSAGE_ID = String(process.env.AUTO_MESSAGE_ID || "Hello");
const AUTO_DATA = String(process.env.AUTO_DATA || "ping");

const AUTO_RESERVE = String(process.env.AUTO_RESERVE || "false") === "true";
const AUTO_RESERVE_CONNECTOR_ID = Number(process.env.AUTO_RESERVE_CONNECTOR_ID || 1);
const AUTO_RESERVE_IDTAG = String(process.env.AUTO_RESERVE_IDTAG || "ABC123");
const AUTO_RESERVE_MINUTES = Number(process.env.AUTO_RESERVE_MINUTES || 30);
const AUTO_RESERVE_RESERVATION_ID = Number(process.env.AUTO_RESERVE_RESERVATION_ID || 101);

const OCPP = { CALL: 2, CALLRESULT: 3, CALLERROR: 4 };

const clients = new Map();           // serial -> ws
const base44Timers = new Map();       // serial -> interval
const pendingCommands = new Map();    // serial -> array of {action, payload}

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

async function sendToBase44(serialNumber, messageArray) {
  if (!BASE44_URL) return;
  try {
    const res = await fetch(BASE44_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serialNumber, message: messageArray }),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.warn("[Base44] falha:", res.status, txt);
    }
  } catch (e) {
    console.warn("[Base44] erro:", String(e?.message || e));
  }
}

function msgStatus(status, info) {
  return [
    OCPP.CALL,
    `${status.toLowerCase()}-${Date.now()}`,
    "StatusNotification",
    {
      connectorId: 0,
      status,
      errorCode: "NoError",
      info: info || undefined,
      timestamp: nowIso(),
    },
  ];
}

function msgHeartbeat() {
  return [OCPP.CALL, `hb-${Date.now()}`, "Heartbeat", {}];
}

/**
 * Respostas mínimas VÁLIDAS (CALLRESULT payload) — OCPP 1.6J
 * Retorna:
 *  - objeto => CALLRESULT
 *  - null   => CALLERROR NotImplemented
 */
function buildImmediateCallResult(action, payload) {
  switch (action) {
    case "BootNotification":
      return { status: "Accepted", currentTime: nowIso(), interval: BOOT_INTERVAL_SEC };
    case "Heartbeat":
      return { currentTime: nowIso() };
    case "StatusNotification":
      return {}; // ok vazio
    case "Authorize":
      return { idTagInfo: { status: "Accepted" } };
    case "StartTransaction":
      return {
        transactionId: Math.floor(Date.now() / 1000),
        idTagInfo: { status: "Accepted" },
      };
    case "StopTransaction":
      return { idTagInfo: { status: "Accepted" } };
    case "MeterValues":
      return {}; // ok vazio
    case "DataTransfer":
      return { status: "Accepted", data: "" };
    case "DiagnosticsStatusNotification":
    case "FirmwareStatusNotification":
      return {}; // ok vazio
    default:
      return null;
  }
}

function safeSend(ws, arr) {
  if (!ws || ws.readyState !== ws.OPEN) return false;
  try {
    ws.send(JSON.stringify(arr));
    return true;
  } catch {
    return false;
  }
}

function enqueueAutoCommands(serialNumber) {
  const q = [];

  if (AUTO_TRIGGER_STATUS) {
    q.push({
      action: "TriggerMessage",
      payload: { requestedMessage: "StatusNotification", connectorId: AUTO_TRIGGER_CONNECTOR_ID },
    });
  }
  if (AUTO_TRIGGER_METER) {
    q.push({
      action: "TriggerMessage",
      payload: { requestedMessage: "MeterValues", connectorId: AUTO_TRIGGER_CONNECTOR_ID },
    });
  }
  if (AUTO_DATATRANSFER) {
    q.push({
      action: "DataTransfer",
      payload: { vendorId: AUTO_VENDOR_ID, messageId: AUTO_MESSAGE_ID, data: AUTO_DATA },
    });
  }
  if (AUTO_RESERVE) {
    const expiry = new Date(Date.now() + AUTO_RESERVE_MINUTES * 60 * 1000).toISOString();
    q.push({
      action: "ReserveNow",
      payload: {
        connectorId: AUTO_RESERVE_CONNECTOR_ID,
        expiryDate: expiry,
        idTag: AUTO_RESERVE_IDTAG,
        reservationId: AUTO_RESERVE_RESERVATION_ID,
      },
    });
  }

  pendingCommands.set(serialNumber, q);
}

function flushPendingCommands(serialNumber, ws) {
  const q = pendingCommands.get(serialNumber) || [];
  if (!q.length) return;

  for (const cmd of q) {
    const messageId = uid();
    const ok = safeSend(ws, [OCPP.CALL, messageId, cmd.action, cmd.payload || {}]);
    if (ok) {
      console.log(`[OCPP OUT] ${serialNumber} CALL ${cmd.action} id=${messageId}`);
    } else {
      console.warn(`[OCPP OUT] ${serialNumber} falha ao enviar ${cmd.action}`);
      break;
    }
  }

  pendingCommands.set(serialNumber, []);
}

// ========= HTTP =========

const server = http.createServer(async (req, res) => {
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
      ts: nowIso(),
    }));
  }

  if (req.method === "POST" && req.url === "/ocpp/send") {
    if (API_KEY && req.headers["x-api-key"] !== API_KEY) {
      res.writeHead(401);
      return res.end("unauthorized");
    }

    let json;
    try { json = JSON.parse(await readBody(req)); }
    catch { res.writeHead(400); return res.end("invalid json"); }

    const { serialNumber, action, payload } = json || {};
    const ws = clients.get(serialNumber);

    if (!ws || ws.readyState !== ws.OPEN) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "charger offline" }));
    }

    const messageId = uid();
    const ok = safeSend(ws, [OCPP.CALL, messageId, action, payload || {}]);

    res.writeHead(ok ? 200 : 500, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok, messageId }));
  }

  res.writeHead(404);
  res.end("not found");
});

// ========= WS =========

const wss = new WebSocketServer({
  server,
  perMessageDeflate: false,
  handleProtocols: (protocols) => {
    const list = protocols instanceof Set ? [...protocols] : protocols || [];
    if (list.includes("ocpp1.6")) return "ocpp1.6";
    return undefined;
  },
});

wss.on("connection", (ws, req) => {
  const u = new URL(req.url || "/", "http://local");
  const parts = u.pathname.split("/").filter(Boolean);
  const serialNumber = (parts.pop() || "").trim() || "UNKNOWN";

  const protoHeader = String(req.headers["sec-websocket-protocol"] || "");
  const negotiated = String(ws.protocol || "");

  console.log(`[WS] conectado ${serialNumber} | negotiated="${negotiated}" | header="${protoHeader}" | path="${u.pathname}" | ${nowIso()}`);

  if (serialNumber === "UNKNOWN" || serialNumber === "monitor") {
    try { ws.close(1008, "Invalid path"); } catch {}
    return;
  }



  clients.set(serialNumber, ws);

  // TCP keepalive: ajuda em proxies/LBs que matam conexão ociosa (~30s)
  try { ws._socket?.setKeepAlive(true, TCP_KEEPALIVE_MS); } catch {}

  // Keepalive ping (opcional)
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  // Enfileira comandos automáticos para disparar após BootNotification
  enqueueAutoCommands(serialNumber);

  // Base44 online (não bloqueia OCPP)
  sendToBase44(serialNumber, msgStatus("Available", "WS Connected")).catch(() => {});

  // Heartbeat “interno” pro Base44
  const t = setInterval(() => {
    const cur = clients.get(serialNumber);
    if (!cur || cur.readyState !== cur.OPEN) return;
    sendToBase44(serialNumber, msgHeartbeat()).catch(() => {});
  }, BASE44_HEARTBEAT_SEC * 1000);
  base44Timers.set(serialNumber, t);

  let firstMsgAt = null;

  ws.on("message", (data) => {
    const rawText = data.toString();
    let msg;

    try { msg = JSON.parse(rawText); }
    catch {
      console.warn("[WS] JSON inválido:", rawText);
      return;
    }

    if (!Array.isArray(msg) || msg.length < 2) {
      console.warn("[WS] formato inválido:", msg);
      return;
    }

    if (!firstMsgAt) {
      firstMsgAt = Date.now();
      console.log(`[WS] primeira msg (${serialNumber}) -> type=${msg[0]} action=${msg[2] || ""}`);
    }

    const messageTypeId = msg[0];

    // ===== CP -> CSMS: CALL =====
    if (messageTypeId === OCPP.CALL) {
      const messageId = msg[1];
      const action = msg[2];
      const payload = msg[3] ?? {};

      console.log(`[OCPP IN] ${serialNumber} CALL action=${action} id=${messageId}`);

      // 1) RESPONDER IMEDIATO (CRÍTICO)
      const respPayload = buildImmediateCallResult(action, payload);

      if (respPayload === null) {
        safeSend(ws, [OCPP.CALLERROR, messageId, "NotImplemented", `Action ${action} not supported`, {}]);
        console.log(`[OCPP OUT] ${serialNumber} CALLERROR action=${action} id=${messageId} (NotImplemented)`);
      } else {
        safeSend(ws, [OCPP.CALLRESULT, messageId, respPayload]);
        console.log(`[OCPP OUT] ${serialNumber} CALLRESULT action=${action} id=${messageId}`);
      }

      // 2) Depois encaminhar pro Base44
      sendToBase44(serialNumber, msg).catch(() => {});

      // 3) Se foi BootNotification, dispare os comandos "logo ao conectar"
      if (action === "BootNotification" && respPayload && respPayload.status === "Accepted") {
        setTimeout(() => flushPendingCommands(serialNumber, ws), 200);
      }

      return;
    }

    // ===== CP -> CSMS: CALLRESULT / CALLERROR =====
    if (messageTypeId === OCPP.CALLRESULT || messageTypeId === OCPP.CALLERROR) {
      console.log(`[OCPP IN] ${serialNumber} type=${messageTypeId} id=${msg[1]}`);
      sendToBase44(serialNumber, msg).catch(() => {});
      return;
    }

    console.warn(`[OCPP IN] ${serialNumber} tipo desconhecido:`, messageTypeId, msg);
  });

  ws.on("close", (code, reasonBuf) => {
    const reason = (reasonBuf ? reasonBuf.toString() : "") || "";
    console.log(`[WS] close ${serialNumber} code=${code} reason="${reason}" at ${nowIso()}`);

    const it = base44Timers.get(serialNumber);
    if (it) clearInterval(it);
    base44Timers.delete(serialNumber);

    clients.delete(serialNumber);
    pendingCommands.delete(serialNumber);

    sendToBase44(serialNumber, msgStatus("Unavailable", `WS Close ${code}`)).catch(() => {});
  });

  ws.on("error", (err) => {
    console.warn(`[WS] erro ${serialNumber}:`, String(err?.message || err));
  });
});

// ping watchdog (opcional)
if (ENABLE_PING) {
  setInterval(() => {
    for (const [serial, ws] of clients.entries()) {
      if (ws.isAlive === false) {
        try { ws.terminate(); } catch {}
        clients.delete(serial);
        pendingCommands.delete(serial);
        sendToBase44(serial, msgStatus("Unavailable", "Ping timeout")).catch(() => {});
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }, PING_INTERVAL_MS);
}

server.listen(PORT, "0.0.0.0", () => {
  console.log("OCPP Gateway rodando na porta " + PORT);
  console.log("BOOT_INTERVAL_SEC=" + BOOT_INTERVAL_SEC);
  console.log("BASE44_HEARTBEAT_SEC=" + BASE44_HEARTBEAT_SEC);
  console.log("ENABLE_PING=" + ENABLE_PING);
  console.log("TCP_KEEPALIVE_MS=" + TCP_KEEPALIVE_MS);
  console.log("AUTO_TRIGGER_STATUS=" + AUTO_TRIGGER_STATUS);
  console.log("AUTO_TRIGGER_METER=" + AUTO_TRIGGER_METER);
  console.log("AUTO_DATATRANSFER=" + AUTO_DATATRANSFER);
  console.log("AUTO_RESERVE=" + AUTO_RESERVE);
});
