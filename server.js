import http from "node:http";
import { WebSocketServer } from "ws";

process.on("uncaughtException", (err) => console.error("UNCAUGHT EXCEPTION:", err));
process.on("unhandledRejection", (err) => console.error("UNHANDLED REJECTION:", err));

const PORT = process.env.PORT || 3000;

const BASE44_URL =
  process.env.BASE44_URL ||
  "https://targetecomobi.base44.app/api/functions/processOcppMessage";

const BASE44_TIMEOUT_MS = Number(process.env.BASE44_TIMEOUT_MS || 8000);
const REQUIRE_OCPP_SUBPROTOCOL =
  String(process.env.REQUIRE_OCPP_SUBPROTOCOL || "false") === "true";

const OCPP = { CALL: 2, CALLRESULT: 3, CALLERROR: 4 };

function nowIso() {
  return new Date().toISOString();
}

function buildCallResult(action) {
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

async function forwardToBase44({ chargePointId, raw, ocppType, messageId, action, payload }) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), BASE44_TIMEOUT_MS);

  try {
    const res = await fetch(BASE44_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        chargePointId,
        ocpp: { ocppType, messageId, action, payload, raw, receivedAt: nowIso() },
      }),
    });

    if (!res.ok) {
      console.warn("[Base44] status:", res.status);
    }
  } catch (e) {
    console.warn("[Base44] erro:", String(e?.message || e));
  } finally {
    clearTimeout(t);
  }
}

// 1) HTTP server (Railway precisa disso pra healthcheck e roteamento)
const server = http.createServer((req, res) => {
  if (req.url === "/monitor") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, ts: nowIso() }));
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("OCPP 1.6J Gateway (Node) OK");
});

// 2) WebSocket em cima do MESMO server/porta
const wss = new WebSocketServer({
  server,
  handleProtocols: (protocols) => {
    const list = protocols instanceof Set ? [...protocols] : protocols || [];
    if (list.includes("ocpp1.6")) return "ocpp1.6";
    if (!REQUIRE_OCPP_SUBPROTOCOL && list.length) return list[0];
    return undefined; // não retorne false
  },
});

wss.on("connection", (ws, req) => {
  const chargePointId = (req.url || "/").replace("/", "") || "UNKNOWN";
  console.log("[WS] conectado:", chargePointId);

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

    // CALL
    if (messageTypeId === OCPP.CALL) {
      const messageId = msg[1];
      const action = msg[2];
      const payload = msg[3] ?? {};

      // responder rápido
      const respPayload = buildCallResult(action);
      ws.send(JSON.stringify([OCPP.CALLRESULT, messageId, respPayload]));

      // enviar para Base44 sem travar
      forwardToBase44({
        chargePointId,
        raw: msg,
        ocppType: "CALL",
        messageId,
        action,
        payload,
      });

      return;
    }

    // CALLRESULT
    if (messageTypeId === OCPP.CALLRESULT) {
      forwardToBase44({
        chargePointId,
        raw: msg,
        ocppType: "CALLRESULT",
        messageId: msg[1],
        action: null,
        payload: msg[2] ?? {},
      });
      return;
    }

    // CALLERROR
    if (messageTypeId === OCPP.CALLERROR) {
      forwardToBase44({
        chargePointId,
        raw: msg,
        ocppType: "CALLERROR",
        messageId: msg[1],
        action: null,
        payload: {
          errorCode: msg[2],
          errorDescription: msg[3],
          errorDetails: msg[4] ?? {},
        },
      });
      return;
    }

    console.warn("[WS] MessageTypeId desconhecido:", msg);
  });

  ws.on("close", () => console.log("[WS] desconectado:", chargePointId));
  ws.on("error", (err) => console.warn("[WS] erro:", chargePointId, err));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP+WS OCPP 1.6J rodando na porta ${PORT}`);
  console.log("Healthcheck: /monitor");
});
