const PORT = Number(Deno.env.get("PORT") ?? "3000");

const BASE44_URL =
  Deno.env.get("BASE44_URL") ??
  "https://targetecomobi.base44.app/api/functions/processOcppMessage";

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
  try {
    await fetch(BASE44_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chargePointId,
        ocpp: { ocppType, messageId, action, payload, raw, receivedAt: nowIso() },
      }),
    });
  } catch (e) {
    console.warn("[Base44] erro:", String(e?.message || e));
  }
}

Deno.serve({ port: PORT, hostname: "0.0.0.0" }, (req) => {
  const url = new URL(req.url);

  if (url.pathname === "/monitor") {
    return new Response(JSON.stringify({ ok: true, ts: nowIso() }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const upgrade = req.headers.get("upgrade") || "";
  if (upgrade.toLowerCase() !== "websocket") {
    return new Response("OCPP 1.6J Gateway (Deno) OK", { status: 200 });
  }

  const { socket, response } = Deno.upgradeWebSocket(req);
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

    if (messageTypeId === OCPP.CALL) {
      const messageId = msg[1];
      const action = msg[2];
      const payload = msg[3] ?? {};

      // responder rápido
      const respPayload = buildCallResult(action);
      socket.send(JSON.stringify([OCPP.CALLRESULT, messageId, respPayload]));

      // enviar base44
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
  };

  return response;
});
