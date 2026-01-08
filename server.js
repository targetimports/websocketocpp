/**
 * server.js — OCPP 1.6J Gateway (WS + HTTP)
 * - Responde IMEDIATO (CALLRESULT) para ações comuns do CP (Boot/Heartbeat/Authorize/Start/Stop/Meter/DataTransfer)
 * - Envia CALLERROR NotImplemented para ações desconhecidas (em vez de retornar payload vazio inválido)
 * - Loga protocolo NEGOCIADO (ws.protocol) e o header recebido
 * - Mantém rotas HTTP: /monitor, /ocpp/clients, /ocpp/send
 *
 * ENV:
 *  PORT=3000
 *  BASE44_URL=https://.../processOcppMessage
 *  API_KEY=...
 *  BOOT_INTERVAL_SEC=30
 *  BASE44_HEARTBEAT_SEC=30
 *  ENABLE_PING=false
 *  PING_INTERVAL_MS=25000
 */

import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 3000);
const BASE44_URL =
  process.env.BASE44_URL ||
  "https://targetecomobi.base44.app/api/functions/processOcppMessage";

const API_KEY = process.env.API_KEY || "";

// Intervalo devolvido no BootNotificationResponse (CP manda Heartbeat baseado nisso)
const BOOT_INTERVAL_SEC = Number(process.env.BOOT_INTERVAL_SEC || 30);

// Heartbeat “interno” pro Base44 (apenas para manter last_heartbeat no seu banco)
const BASE44_HEARTBEAT_SEC = Number(process.env.BASE44_HEARTBEAT_SEC || 30);

// ⚠️ Alguns CPs derrubam se o servidor enviar ping.
// Deixe false por padrão. Se necessário, ENABLE_PING=true
const ENABLE_PING = String(process.env.ENABLE_PING || "false") === "true";
const PING_INTERVAL_MS = Number(process.env.PING_INTERVAL_MS || 25000);

const OCPP = { CALL: 2, CALLRESULT: 3, CALLERROR: 4 };

const clients = new Map(); // serial -> ws
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

/**
 * Respostas mínimas VÁLIDAS OCPP 1.6J (CALLRESULT payload)
 * Retorne:
 *  - objeto => CALLRESULT
 *  - null => CALLERROR NotImplemented (melhor que {} inválido)
 */
function buildImmediateCallResult(action, payload) {
  switch (action) {
    case "BootNotification":
      return {
        status: "Accepted",
        currentTime: nowIso(),
        interval: BOOT_INTERVAL_SEC,
      };

    case "Heartbeat":
      return { currentTime: nowIso() };

    case "StatusNotification":
      return {}; // ok vazio

    case "Authorize":
      // obrigatório: idTagInfo
      return { idTagInfo: { status: "Accepted" } };

    case "StartTransaction":
      // obrigatório: transactionId e idTagInfo
      return {
        transactionId: Math.floor(Date.now() / 1000),
        idTagInfo: { status: "Accepted" },
      };

    case "StopTransaction":
      // obrigatório: idTagInfo
      return { idTagInfo: { status: "Accepted" } };

    case "MeterValues":
      return {}; // ok vazio

    case "DataTransfer":
      // obrigatório: status
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
  } catch (e) {
    return false;
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
    return res.end(
      JSON.stringify({
        ok: true,
        clients: [...clients.keys()],
        count: clients.size,
        ts: nowIso(),
      })
    );
  }

  if (req.method === "POST" && req.url === "/ocpp/send") {
    if (API_KEY && req.headers["x-api-key"] !== API_KEY) {
      res.writeHead(401);
      return res.end("unauthorized");
    }

    let json;
    try {
      json = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400);
      return res.end("invalid json");
    }

    const { serialNumber, action, payload } = json || {};
    const ws = clients.get(serialNumber);

    if (!ws || ws.readyState !== ws.OPEN) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "charger offline" }));
    }

    const messageId = uid();
    // CSMS -> CP (CALL)
    safeSend(ws, [OCPP.CALL, messageId, action, payload || {}]);

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, messageId }));
  }

  res.writeHead(404);
  res.end("not found");
});

// ========= WS =========

const wss = new WebSocketServer({
  server,
  /**
   * OCPP 1.6J normalmente exige subprotocol "ocpp1.6"
   * - se o client oferecer "ocpp1.6", aceitamos.
   * - se não oferecer, aceitamos undefined (sem subprotocol), mas muitos CPs não gostam.
   */
  handleProtocols: (protocols) => {
    const list = protocols instanceof Set ? [...protocols] : protocols || [];
    if (list.includes("ocpp1.6")) return "ocpp1.6";
    return undefined;
  },
});

wss.on("connection", (ws, req) => {
  // Extrai o último segmento do path (serve /ocpp/2222 e /2222)
  const u = new URL(req.url || "/", "http://local");
  const parts = u.pathname.split("/").filter(Boolean);
  const serialNumber = (parts.pop() || "").trim() || "UNKNOWN";

  const protoHeader = String(req.headers["sec-websocket-protocol"] || "");
  const negotiated = String(ws.protocol || ""); // ✅ o que realmente foi negociado

  console.log(
    `[WS] conectado ${serialNumber} | negotiated="${negotiated}" | header="${protoHeader}" | path="${u.pathname}" | ${nowIso()}`
  );

  // Rejeita conexões “estranhas”
  if (serialNumber === "UNKNOWN" || serialNumber === "monitor") {
    try {
      ws.close(1008, "Invalid path");
    } catch {}
    return;
  }

  // Se você quiser ser MAIS rígido (recomendado em produção):
  // Se o CP não negociar "ocpp1.6", encerra.
  if (negotiated !== "ocpp1.6") {
    console.warn(
      `[WS] ${serialNumber} sem subprotocol ocpp1.6 negociado (negotiated="${negotiated}"). Encerrando.`
    );
    try {
      ws.close(1002, "Subprotocol required: ocpp1.6");
    } catch {}
    return;
  }

  clients.set(serialNumber, ws);

  // Keepalive ping (opcional)
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  // avisa Base44 online (não bloqueia OCPP)
  sendToBase44(serialNumber, msgStatus("Available", "WS Connected")).catch(
    () => {}
  );

  // heartbeat “interno” pro Base44
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

    try {
      msg = JSON.parse(rawText);
    } catch {
      console.warn("[WS] JSON inválido:", rawText);
      return;
    }

    if (!Array.isArray(msg) || msg.length < 2) {
      console.warn("[WS] formato inválido:", msg);
      return;
    }

    if (!firstMsgAt) {
      firstMsgAt = Date.now();
      console.log(
        `[WS] primeira msg (${serialNumber}) -> type=${msg[0]} action=${msg[2] || ""}`
      );
    }

    const messageTypeId = msg[0];

    // ===== CP -> CSMS: CALL =====
    if (messageTypeId === OCPP.CALL) {
      const messageId = msg[1];
      const action = msg[2];
      const payload = msg[3] ?? {};

      console.log(
        `[OCPP IN] ${serialNumber} CALL action=${action} id=${messageId}`
      );

      // 1) RESPONDE IMEDIATO (CRÍTICO)
      const respPayload = buildImmediateCallResult(action, payload);

      if (respPayload === null) {
        // melhor responder erro do que payload vazio inválido
        const err = [
          OCPP.CALLERROR,
          messageId,
          "NotImplemented",
          `Action ${action} not supported`,
          {},
        ];
        safeSend(ws, err);
        console.log(
          `[OCPP OUT] ${serialNumber} CALLERROR action=${action} id=${messageId} (NotImplemented)`
        );
      } else {
        const ok = [OCPP.CALLRESULT, messageId, respPayload];
        safeSend(ws, ok);
        console.log(
          `[OCPP OUT] ${serialNumber} CALLRESULT action=${action} id=${messageId}`
        );
      }

      // 2) Depois encaminha pro Base44 (não bloqueia)
      sendToBase44(serialNumber, msg).catch(() => {});
      return;
    }

    // ===== CP -> CSMS: CALLRESULT / CALLERROR =====
    if (messageTypeId === OCPP.CALLRESULT || messageTypeId === OCPP.CALLERROR) {
      console.log(
        `[OCPP IN] ${serialNumber} type=${messageTypeId} id=${msg[1]}`
      );
      sendToBase44(serialNumber, msg).catch(() => {});
      return;
    }

    console.warn(
      `[OCPP IN] ${serialNumber} tipo desconhecido:`,
      messageTypeId,
      msg
    );
  });

  ws.on("close", (code, reasonBuf) => {
    const reason = (reasonBuf ? reasonBuf.toString() : "") || "";
    console.log(
      `[WS] close ${serialNumber} code=${code} reason="${reason}" at ${nowIso()}`
    );

    const it = base44Timers.get(serialNumber);
    if (it) clearInterval(it);
    base44Timers.delete(serialNumber);

    clients.delete(serialNumber);

    sendToBase44(
      serialNumber,
      msgStatus("Unavailable", `WS Close ${code}`)
    ).catch(() => {});
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
        try {
          ws.terminate();
        } catch {}
        clients.delete(serial);
        sendToBase44(serial, msgStatus("Unavailable", "Ping timeout")).catch(
          () => {}
        );
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
  console.log("OCPP Gateway rodando na porta " + PORT);
  console.log("BOOT_INTERVAL_SEC=" + BOOT_INTERVAL_SEC);
  console.log("BASE44_HEARTBEAT_SEC=" + BASE44_HEARTBEAT_SEC);
  console.log("ENABLE_PING=" + ENABLE_PING);
});
