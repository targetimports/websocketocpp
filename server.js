import http from "http";
import { WebSocketServer } from "ws";
import crypto from "crypto";

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});

// Endpoint Base44 (ajuste se quiser)
const BASE44_URL =
  process.env.BASE44_URL ||
  "https://targetecomobi.base44.app/api/functions/processOcppMessage";

// Timeout para chamadas ao Base44
const BASE44_TIMEOUT_MS = Number(process.env.BASE44_TIMEOUT_MS || 8000);

// Opcional: exigir subprotocol "ocpp1.6" (alguns carregadores pedem)
const REQUIRE_OCPP_SUBPROTOCOL = String(process.env.REQUIRE_OCPP_SUBPROTOCOL || "false") === "true";

// ---- Utilidades OCPP 1.6 ----
const OCPP = {
  CALL: 2,
  CALLRESULT: 3,
  CALLERROR: 4,
};

function nowIso() {
  return new Date().toISOString();
}

function randomId() {
  return crypto.randomBytes(12).toString("hex");
}

function safeJsonParse(str) {
  try {
    return { ok: true, value: JSON.parse(str) };
  } catch (e) {
    return { ok: false, error: e };
  }
}

function wsSendJson(ws, obj) {
  ws.send(JSON.stringify(obj));
}

function callError(messageId, errorCode, errorDescription, errorDetails = {}) {
  return [OCPP.CALLERROR, messageId, errorCode, errorDescription, errorDetails];
}

// Respostas padrão (você pode customizar para seu negócio)
function buildCallResult(action, payload) {
  switch (action) {
    case "BootNotification":
      return {
        status: "Accepted",
        currentTime: nowIso(),
        interval: 300, // segundos
      };

    case "Heartbeat":
      return { currentTime: nowIso() };

    case "Authorize":
      return {
        idTagInfo: {
          status: "Accepted", // ou "Invalid" / "Blocked" etc
        },
      };

    case "StartTransaction":
      return {
        transactionId: Math.floor(Math.random() * 1e9),
        idTagInfo: { status: "Accepted" },
      };

    case "StopTransaction":
      return {
        idTagInfo: { status: "Accepted" },
      };

    case "StatusNotification":
    case "MeterValues":
    case "DataTransfer":
    default:
      // A maioria pode responder {} e o carregador aceita
      // Para DataTransfer, a spec permite status.
      if (action === "DataTransfer") return { status: "Accepted" };
      return {};
  }
}

// Encaminha para Base44 com timeout e sem travar a resposta OCPP
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
        ocpp: {
          ocppType,     // "CALL" | "CALLRESULT" | "CALLERROR"
          messageId,
          action,
          payload,
          raw,
          receivedAt: nowIso(),
        },
      }),
    });

    // Se o Base44 retornar algo útil (ex: instrução para alterar resposta), você pode ler:
    // const data = await res.json().catch(() => null);

    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  } finally {
    clearTimeout(t);
  }
}

// ---- HTTP server (healthcheck + info) ----
const server = http.createServer((req, res) => {
  if (req.url === "/monitor") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, ts: nowIso() }));
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("OCPP 1.6J Gateway OK");
});

// ---- WebSocket server (OCPP) ----
const wss = new WebSocketServer({
  server,
  // Para aceitar o subprotocol ocpp1.6, se necessário:
  handleProtocols: (protocols /* Set<string> */, request) => {
    if (!protocols || protocols.size === 0) return false;

    if (protocols.has("ocpp1.6")) return "ocpp1.6";

    // Se você não quer exigir, pode aceitar o primeiro
    if (!REQUIRE_OCPP_SUBPROTOCOL) {
      return [...protocols][0];
    }
    return false;
  },
});

wss.on("connection", (ws, req) => {
  // Ex: wss://host/CP_001 -> req.url = "/CP_001"
  const chargePointId = (req.url || "/").replace("/", "") || "UNKNOWN";

  console.log(`[WS] conectado: ${chargePointId}`);

  ws.on("message", async (data) => {
    const text = data.toString();

    const parsed = safeJsonParse(text);
    if (!parsed.ok) {
      console.warn(`[WS] JSON inválido de ${chargePointId}:`, text);
      // Sem messageId não dá pra responder CALLERROR corretamente
      return;
    }

    const msg = parsed.value;

    // OCPP 1.6 JSON é um array: [MessageTypeId, UniqueId, Action?, Payload?]
    if (!Array.isArray(msg) || msg.length < 3) {
      console.warn(`[WS] formato OCPP inválido de ${chargePointId}:`, msg);
      return;
    }

    const messageTypeId = msg[0];

    // ---- CALL (2) do carregador para o servidor ----
    if (messageTypeId === OCPP.CALL) {
      const messageId = msg[1];
      const action = msg[2];
      const payload = msg[3] ?? {};

      // Responder rápido para não derrubar a sessão
      try {
        const responsePayload = buildCallResult(action, payload);
        const callResult = [OCPP.CALLRESULT, messageId, responsePayload];
        wsSendJson(ws, callResult);

        // Envia para o Base44 em paralelo (não bloqueia)
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

      } catch (err) {
        console.error(`[WS] erro ao processar CALL ${action} (${chargePointId}):`, err);
        wsSendJson(ws, callError(messageId, "InternalError", "Unhandled server error"));
      }

      return;
    }

    // ---- CALLRESULT (3) - resposta do carregador a um comando que o servidor enviou ----
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

    // ---- CALLERROR (4) ----
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
