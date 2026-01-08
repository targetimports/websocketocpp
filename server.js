import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 3000);
const BASE44_URL =
  process.env.BASE44_URL ||
  "https://targetecomobi.base44.app/api/functions/processOcppMessage";

const API_KEY = process.env.API_KEY || "";
const HEARTBEAT_INTERVAL_SEC = Number(process.env.HEARTBEAT_INTERVAL_SEC || 30);

// ping/pong para não cair por idle
const ENABLE_PING = String(process.env.ENABLE_PING || "true") === "true";
const PING_INTERVAL_MS = Number(process.env.PING_INTERVAL_MS || 25000);

const OCPP = { CALL: 2, CALLRESULT: 3, CALLERROR: 4 };

const clients = new Map();  // serialNumber -> ws
const hbTimers = new Map(); // serialNumber -> intervalId

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

// status “online/offline” via OCPP válido (para Base44)
function msgStatus(status, info) {
  return [
    OCPP.CALL,
    `${status.toLowerCase()}-${Date.now()}`,
    "StatusNotification",
    {
      connectorId: 0,
      status, // Available | Unavailable
      errorCode: "NoError",
      info: info || undefined,
      timestamp: nowIso(),
    },
  ];
}

function msgHeartbeat() {
  return [OCPP.CALL, `hb-${Date.now()}`, "Heartbeat", {}];
}

// resposta imediata (OCPP) — NÃO depende de Base44
function buildImmediateCallResult(action) {
  switch (action) {
    case "BootNotification":
      return {
        status: "Accepted",
        currentTime: nowIso(),
        interval: HEARTBEAT_INTERVAL_SEC,
      };
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
    case "StatusNotification":
      return {}; // spec permite payload vazio aqui
    case "MeterValues":
      return {};
    default:
      return {};
  }
}

/* ===================== HTTP SERVER ===================== */

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("OCPP 1.6J Gateway OK");
  }

  if (req.method === "GET" && req.url === "/monitor") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, ts: nowIso() }));
  }

  if (req.method === "GET" && req.url === "/ocpp/clients") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({ ok: true, count: clients.size, clients: [...clients.keys()], ts: nowIso() })
    );
  }

  // enviar comando do servidor -> carregador
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

    const messageId = uid();
    const msg = [OCPP.CALL, messageId, action, payload || {}];
    ws.send(JSON.stringify(msg));

    // log pro Base44 (sem travar HTTP)
    sendToBase44(serialNumber, msg).catch(() => {});

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, messageId }));
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});

/* ===================== WEBSOCKET SERVER ===================== */

const wss = new WebSocketServer({
  server,
  handleProtocols: (protocols) => {
    const list = protocols instanceof Set ? [...protocols] : protocols || [];
    // ✅ muitos carregadores exigem isso
    if (list.includes("ocpp1.6")) return "ocpp1.6";
    // se seu carregador não manda subprotocol, troque para:
    // return list[0] || "ocpp1.6";
    return false;
  },
});

wss.on("connection", (ws, req) => {
  const serialNumber = (req.url || "/").replace("/", "").trim() || "UNKNOWN";

  // log útil p/ debug
  console.log("[WS] conectado:", serialNumber, "subprotocol:", req.headers["sec-websocket-protocol"] || "");

  // bloqueia path indevido
  if (serialNumber === "monitor" || serialNumber === "UNKNOWN" || serialNumber === "") {
    try { ws.close(); } catch {}
    return;
  }

  // ajuste se serial tiver letras
  // if (!/^\d{6,}$/.test(serialNumber)) { ws.close(); return; }

  clients.set(serialNumber, ws);

  // ping/pong watchdog
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  // ✅ notifica Base44 online (sem bloquear)
  sendToBase44(serialNumber, msgStatus("Available", "WS Connected")).catch(() => {});

  // ✅ heartbeat automático para Base44 (mantém last_heartbeat no seu modelo)
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

    // ✅ CP -> CSMS: CALL
    if (messageTypeId === OCPP.CALL) {
      const messageId = msg[1];
      const action = msg[2];
      const payload = msg[3] ?? {};

      // ✅ RESPOSTA IMEDIATA PRIMEIRO (CRÍTICO)
      const respPayload = buildImmediateCallResult(action);
      try {
        ws.send(JSON.stringify([OCPP.CALLRESULT, messageId, respPayload]));
      } catch (e) {
        console.warn("[WS] falha ao enviar CALLRESULT:", String(e?.message || e));
      }

      // ✅ depois loga no Base44 (NUNCA bloqueia a resposta)
      sendToBase44(serialNumber, msg).catch(() => {});
      return;
    }

    // ✅ CP -> CSMS: CALLRESULT / CALLERROR
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

    // notifica Base44 offline (sem bloquear)
    sendToBase44(serialNumber, msgStatus("Unavailable", "WS Disconnected")).catch(() => {});
  });

  ws.on("error", (err) => {
    console.warn("[WS] erro:", serialNumber, String(err?.message || err));
  });
});

// ✅ watchdog global ping (resolve o “~40s” em muitos ambientes)
if (ENABLE_PING) {
  setInterval(() => {
    for (const [serial, ws] of clients.entries()) {
      if (ws.isAlive === false) {
        try { ws.terminate(); } catch {}
        clients.delete(serial);
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
  console.log("Health: /monitor");
});
