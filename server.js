import http from "http";
import { WebSocketServer } from "ws";
import crypto from "crypto";

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});

const PORT = process.env.PORT || 3000;

// Base44 function endpoint
const BASE44_URL =
  process.env.BASE44_URL ||
  "https://targetecomobi.base44.app/api/functions/processOcppMessage";

const BASE44_TIMEOUT_MS = Number(process.env.BASE44_TIMEOUT_MS || 8000);

// Se seu carregador exigir subprotocol "ocpp1.6", coloque true
const REQUIRE_OCPP_SUBPROTOCOL =
  String(process.env.REQUIRE_OCPP_SUBPROTOCOL || "false") === "true";

const OCPP = { CALL: 2, CALLRESULT: 3, CALLERROR: 4 };

function nowIso() {
  return new Date().toISOString();
}

function wsSendJson(ws, obj) {
  ws.send(JSON.stringify(obj));
}

function callError(messageId, errorCode, errorDescription, errorDetails = {}) {
  return [OCPP.CALLERROR, messageId, errorCode, errorDescription, errorDetails];
}

// Respostas padrão OCPP 1.6J (mínimo necessário para manter a sessão viva)
function buildCallResult(action, payload) {
  switch (action) {
    case "BootNotification":
      return {
        status: "Accepted",
        currentTime: nowIso(),
        interval: 300,
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

    case "DataTransfer":
      return { status: "Accepted" };

    // StatusNotification, MeterValues, DiagnosticsStatusNotification etc.
    default:
      return {};
  }
}

async function forwardToBase44({
  chargePointId,
  raw,
  ocppType,
  messageId,
  action,
  payload,
}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), BASE44_TIMEOUT_MS);

  try {
    const res = await fetch(BASE44_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        chargePointId,
        ocpp: {
          ocppType, // CALL | CALLRESULT | CALLERROR
          messageId,
          action,
          payload,
          raw,
          receivedAt: nowIso(),
        },
      }),
    });

    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  } finally {
    clearTimeout(t);
  }
}

// HTTP server (necessário no Railway p/ healthcheck e evitar 499)
const server = http.createServer((req, res) => {
  if (req.url === "/monitor") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, ts: nowIso() }));
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("OCPP 1.6J Gateway OK");
});

// WebSocket em cima do MESMO server (porta única do Railway)
const wss = new WebSocketServer({
  server,
  handleProtocols: (protocols) => {
    // ws pode passar Set<string> (mais comum) ou array
    const list = protocols instanceof Set ? [...protocols] : protocols || [];

    // OCPP 1.6 JSON costuma usar "ocpp1.6"
    if (list.includes("ocpp1.6")) return "ocpp1.6";

    // Se não exigir, aceita qualquer subprotocol enviado
    if (!REQUIRE_OCPP_SUBPROTOCOL && list.length) return list[0];

    // ⚠️ Em vez de false, use undefined (mais compatível)
    return undefined;
  },
});

wss.on("connection", (ws, req) => {
  const chargePointId = (req.url || "/").replace("/", "") || "UNKNOWN";
  console.log(`[WS] conectado: ${chargePointId}`);

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.warn(`[WS] JSON inválido ${chargePointId}:`, data.toString());
      return;
    }

    // OCPP 1.6 JSON: [MessageTypeId, UniqueId, Action?, Payload?]
    if (!Array.isArray(msg) || msg.length < 2) {
      console.warn(`[WS] formato inválido ${chargePointId}:`, msg);
      return;
    }

    const messageTypeId = msg[0];

    // ---------- CALL ----------
    if (messageTypeId === OCPP.CALL) {
      const messageId = msg[1];
      const action = msg[2];
      const payload = msg[3] ?? {};

      // 1) Responder imediatamente para manter a sessão OCPP estável
      try {
        const responsePayload = buildCallResult(action, payload);
        wsSendJson(ws, [OCPP.CALLRESULT, messageId, responsePayload]);
      } catch (err) {
        console.error(`[WS] erro ao responder CALL (${chargePointId})`, err);
        wsSendJson(ws, callError(messageId, "InternalError", "Server error"));
        return;
      }

      // 2) Encaminhar para Base44 sem bloquear o WebSocket
      forwardToBase44({
        chargePointId,
        raw: msg,
        ocppType: "CALL",
        messageId,
        action,
        payload,
      }).then((r) => {
        if (!r.ok) console.warn(`[Base44] falha (${chargePointId})`, r);
      });

      return;
    }

    // ---------- CALLRESULT ----------
    if (messageTypeId === OCPP.CALLRESULT) {
      const messageId = msg[1];
      const payload = msg[2] ?? {};

      forwardToBase44({
        chargePointId,
        raw: msg,
        ocppType: "CALLRESULT",
        messageId,
        action: null,
        payload,
      }).then((r) => {
        if (!r.ok) console.warn(`[Base44] falha CALLRESULT (${chargePointId})`, r);
      });

      return;
    }

    // ---------- CALLERROR ----------
    if (messageTypeId === OCPP.CALLERROR) {
      const messageId = msg[1];
      const errorCode = msg[2];
      const errorDescription = msg[3];
      const errorDetails = msg[4] ?? {};

      forwardToBase44({
        chargePointId,
        raw: msg,
        ocppType: "CALLERROR",
        messageId,
        action: null,
        payload: { errorCode, errorDescription, errorDetails },
      }).then((r) => {
        if (!r.ok) console.warn(`[Base44] falha CALLERROR (${chargePointId})`, r);
      });

      return;
    }

    console.warn(`[WS] MessageTypeId desconhecido (${chargePointId}):`, msg);
  });

  ws.on("close", () => console.log(`[WS] desconectado: ${chargePointId}`));
  ws.on("error", (err) => console.error(`[WS] erro: ${chargePointId}`, err));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP+WS OCPP 1.6J rodando na porta ${PORT}`);
  console.log(`Healthcheck: /monitor`);
});
