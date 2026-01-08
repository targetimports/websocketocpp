import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 3000);
const BASE44_URL =
  process.env.BASE44_URL ||
  "https://targetecomobi.base44.app/api/functions/processOcppMessage";

const API_KEY = process.env.API_KEY || "";

// Intervalo que você devolve no BootNotificationResponse (o CP vai mandar Heartbeat baseado nisso)
const BOOT_INTERVAL_SEC = Number(process.env.BOOT_INTERVAL_SEC || 30);

// Heartbeat que o gateway manda pro Base44 (só pra manter last_heartbeat no seu modelo)
const BASE44_HEARTBEAT_SEC = Number(process.env.BASE44_HEARTBEAT_SEC || 30);

// ⚠️ Alguns carregadores derrubam se o servidor enviar ping.
// Deixe desligado por padrão. Se quiser testar, set ENABLE_PING=true
const ENABLE_PING = String(process.env.ENABLE_PING || "false") === "true";
const PING_INTERVAL_MS = Number(process.env.PING_INTERVAL_MS || 25000);

const OCPP = { CALL: 2, CALLRESULT: 3, CALLERROR: 4 };

const clients = new Map();  // serial -> ws
const base44Timers = new Map(); // serial -> interval

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

function buildImmediateCallResult(action) {
  switch (action) {
    case "BootNotification":
      return { status: "Accepted", currentTime: nowIso(), interval: BOOT_INTERVAL_SEC };
    case "Heartbeat":
      return { currentTime: nowIso() };
    case "StatusNotification":
      return {};
    default:
      return {};
  }
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
    ws.send(JSON.stringify([OCPP.CALL, messageId, action, payload || {}]));
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, messageId }));
  }

  res.writeHead(404);
  res.end("not found");
});

// ========= WS =========

const wss = new WebSocketServer({
  server,

  // ✅ Não seja “duro” no protocolo enquanto estamos debugando:
  // Aceita ocpp1.6 se vier; se não vier, aceita mesmo assim.
  handleProtocols: (protocols) => {
    const list = protocols instanceof Set ? [...protocols] : protocols || [];
    if (list.includes("ocpp1.6")) return "ocpp1.6";
    return list[0] || undefined; // aceita sem subprotocol
  },
});

wss.on("connection", (ws, req) => {
  // ✅ extrai o último segmento do path (resolve /ocpp/2222233333 e /2222233333)
  const u = new URL(req.url || "/", "http://local");
  const parts = u.pathname.split("/").filter(Boolean);
  const serialNumber = (parts.pop() || "").trim() || "UNKNOWN";

  const proto = req.headers["sec-websocket-protocol"] || "";
  console.log(`[WS] conectado ${serialNumber} | proto="${proto}" | path="${u.pathname}" | ${nowIso()}`);

  if (serialNumber === "UNKNOWN" || serialNumber === "monitor") {
    try { ws.close(); } catch {}
    return;
  }

  clients.set(serialNumber, ws);

  // (Opcional) keepalive ping — DESLIGADO por padrão
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  // avisa Base44 online (não bloqueia OCPP)
  sendToBase44(serialNumber, msgStatus("Available", "WS Connected")).catch(() => {});

  // heartbeat “interno” pro Base44 (só pra marcar online no seu banco)
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
      console.log(`[WS] primeira msg em ${firstMsgAt} (${serialNumber}) ->`, msg[2] || msg[0]);
    }

    const messageTypeId = msg[0];

    // ✅ CP -> CSMS CALL: RESPONDE IMEDIATO
    if (messageTypeId === OCPP.CALL) {
      const messageId = msg[1];
      const action = msg[2];
      const payload = msg[3] ?? {};

      // log action
      console.log(`[OCPP IN] ${serialNumber} CALL action=${action} id=${messageId}`);

      const respPayload = buildImmediateCallResult(action);

      // CRÍTICO: responder ANTES do Base44
      try {
        ws.send(JSON.stringify([OCPP.CALLRESULT, messageId, respPayload]));
        console.log(`[OCPP OUT] ${serialNumber} CALLRESULT action=${action} id=${messageId}`);
      } catch (e) {
        console.warn("[WS] falha ao responder:", String(e?.message || e));
      }

      // depois manda pro Base44
      sendToBase44(serialNumber, msg).catch(() => {});
      return;
    }

    // CALLRESULT / CALLERROR
    if (messageTypeId === OCPP.CALLRESULT || messageTypeId === OCPP.CALLERROR) {
      console.log(`[OCPP IN] ${serialNumber} type=${messageTypeId} id=${msg[1]}`);
      sendToBase44(serialNumber, msg).catch(() => {});
      return;
    }
  });

  ws.on("close", (code, reasonBuf) => {
    const reason = (reasonBuf ? reasonBuf.toString() : "") || "";
    console.log(`[WS] close ${serialNumber} code=${code} reason="${reason}" at ${nowIso()}`);

    const it = base44Timers.get(serialNumber);
    if (it) clearInterval(it);
    base44Timers.delete(serialNumber);

    clients.delete(serialNumber);

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
  console.log("BOOT_INTERVAL_SEC=" + BOOT_INTERVAL_SEC + " (enviado no BootNotificationResponse)");
  console.log("ENABLE_PING=" + ENABLE_PING);
});
