// DENO server (Railway rodando como Deno)
// OCPP 1.6J over WebSocket + healthcheck /monitor + forward to Base44

const PORT = Number(Deno.env.get("PORT") ?? "3000");

const BASE44_URL =
  Deno.env.get("BASE44_URL") ??
  "https://targetecomobi.base44.app/api/functions/processOcppMessage";

const OCPP = { CALL: 2, CALLRESULT: 3, CALLERROR: 4 };

function nowIso() {
  return new Date().toISOString();
}

function buildCallResult(action, payload) {
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
  try {
    const res = await fetch(BASE44_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chargePointId,
        ocpp: {
          ocppType,
          messageId,
          action,
          payload,
          raw,
          receivedAt: nowIso(),
        },
      }),
    });
    if (!res.ok) {
      console.warn("[Base44] status:", res.status);
    }
  } catch (e) {
    console.warn("[Base44] erro:", String(e?.message || e));
  }
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve({ port: PORT, hostname: "0.0.0.0" }, (req) => {
  const url = new URL(req.url);

  // Healthcheck Railway
  if (url.pathname === "/monitor") {
    return jsonResponse({ ok: true, ts: nowIso() });
  }

  // WebSocket upgrade
  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() !== "websocket") {
    return new Response("OCPP 1.6J Gateway (Deno) OK", { status: 200 });
  }

  // Aceita WebSocket
  const { socket, response } = Deno.upgradeWebSocket(req);

  // chargePointId vem do path: /CP_123
  const chargePointId = (url.pathname || "/").replace("/", "") || "UNKNOWN";
  console.log("[WS] conectado:", chargePointId);

  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      console.warn("[WS] JSON inválido:", event.data);
      return;
    }

    if (!Array.isArray(msg) || msg.length < 2) {
      console.warn("[WS] formato inválido:", msg);
      return;
    }

    const messageTypeId = msg[0];

    // CALL do carregador
    if (messageTypeId === OCPP.CALL) {
      const messageId = msg[1];
      const action = msg[2];
      const payload = msg[3] ?? {};

      // Responder rápido
      try {
        const responsePayload = buildCallResult(action, payload);
        socket.send(JSON.stringify([OCPP.CALLRESULT, messageId, responsePayload]));
      } catch (e) {
        socket.send(JSON.stringify([OCPP.CALLERROR, messageId, "InternalError", "Server error", {}]));
        return;
      }

      // Enviar pro Base44 em paralelo
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

    // CALLRESULT (resposta do carregador)
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
      });
      return;
    }

    // CALLERROR
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
      });
      return;
    }

    console.warn("[WS] MessageTypeId desconhecido:", msg);
  };

  socket.onclose = () => console.log("[WS] desconectado:", chargePointId);
  socket.onerror = (e) => console.warn("[WS] erro:", chargePointId, e);

  return response;
});
