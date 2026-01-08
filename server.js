import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 3000;
const BASE44_URL = process.env.BASE44_URL; // seu function endpoint
const API_KEY = process.env.API_KEY || ""; // opcional p/ proteger /ocpp/send

const OCPP = { CALL: 2, CALLRESULT: 3, CALLERROR: 4 };

const clients = new Map(); // chargePointId -> ws
const pendingRequests = new Map(); // messageId -> { chargePointId, action, createdAt }

function nowIso() { return new Date().toISOString(); }
function uid() { return Math.random().toString(16).slice(2) + Date.now().toString(16); }

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

function sendOcppCall(ws, chargePointId, action, payload) {
  const messageId = uid();
  const msg = [OCPP.CALL, messageId, action, payload ?? {}];
  pendingRequests.set(messageId, { chargePointId, action, createdAt: Date.now() });
  ws.send(JSON.stringify(msg));
  return messageId;
}

async function handleIncomingCallFromCp({ chargePointId, ws, messageId, action, payload, raw }) {
  // Pergunta ao Base44 qual resposta e quais comandos disparar
  const r = await postJson(BASE44_URL, {
    chargePointId,
    direction: "FROM_CP",
    type: "CALL",
    messageId,
    action,
    payload,
    raw,
    receivedAt: nowIso(),
  });

  // Fallback se Base44 falhar
  const callResult = (r.ok && r.json?.callResult) ? r.json.callResult : {};
  ws.send(JSON.stringify([OCPP.CALLRESULT, messageId, callResult]));

  // Comandos sugeridos pelo Base44
  const commands = (r.ok && Array.isArray(r.json?.commands)) ? r.json.commands : [];
  for (const cmd of commands) {
    if (!cmd?.action) continue;
    sendOcppCall(ws, chargePointId, cmd.action, cmd.payload || {});
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}




const server = http.createServer(async (req, res) => {
  // ✅ raiz (pra abrir no navegador sem 404)
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("OCPP 1.6J Gateway OK");
  }

  // ✅ healthcheck Railway
  if (req.method === "GET" && req.url === "/monitor") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, ts: nowIso() }));
  }

  // (opcional) listar pontos conectados
  if (req.method === "GET" && req.url === "/ocpp/clients") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      ok: true,
      clients: [...clients.keys()],
      count: clients.size,
      ts: nowIso()
    }));
  }

  // ✅ Base44 -> Node: enviar comando a qualquer momento
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

    const messageId = sendOcppCall(ws, chargePointId, action, payload);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, messageId }));
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
});


const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const chargePointId = (req.url || "/").replace("/", "") || "UNKNOWN";
  clients.set(chargePointId, ws);
  console.log("[WS] conectado:", chargePointId);

  ws.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!Array.isArray(msg) || msg.length < 2) return;

    const type = msg[0];

    // CP -> Server
    if (type === OCPP.CALL) {
      const messageId = msg[1];
      const action = msg[2];
      const payload = msg[3] ?? {};
      await handleIncomingCallFromCp({ chargePointId, ws, messageId, action, payload, raw: msg });
      return;
    }

    // Resposta do CP a comandos do servidor
    if (type === OCPP.CALLRESULT || type === OCPP.CALLERROR) {
      const messageId = msg[1];
      const pending = pendingRequests.get(messageId);
      if (pending) pendingRequests.delete(messageId);

      // Envia retorno ao Base44 (resultado do comando)
      await postJson(BASE44_URL, {
        chargePointId,
        direction: "FROM_CP",
        type: type === OCPP.CALLRESULT ? "CALLRESULT" : "CALLERROR",
        messageId,
        pendingAction: pending?.action || null,
        payload: type === OCPP.CALLRESULT ? (msg[2] ?? {}) : {
          errorCode: msg[2], errorDescription: msg[3], errorDetails: msg[4] ?? {}
        },
        raw: msg,
        receivedAt: nowIso(),
      });

      return;
    }
  });

  ws.on("close", () => {
    clients.delete(chargePointId);
    console.log("[WS] desconectado:", chargePointId);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`OCPP Gateway rodando na porta ${PORT}`);
});
