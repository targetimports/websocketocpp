/**
 * Railway OCPP WebSocket Server
 * Este servidor roda no Railway e mantém conexões WebSocket com carregadores.
 * Envia mensagens OCPP recebidas para o Base44 via HTTP POST.
 */

const activeConnections = new Map();
const BASE44_PROCESS_URL = process.env.BASE44_PROCESS_URL || 'https://targetecomobi.base44.app/api/functions/processOcppMessage';

Deno.serve(async (req) => {
  try {
    const upgrade = req.headers.get("upgrade") || "";
    const url = new URL(req.url);

    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        activeConnections: activeConnections.size,
        timestamp: new Date().toISOString()
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (upgrade.toLowerCase() !== "websocket") {
      return new Response(JSON.stringify({
        error: 'Expected WebSocket upgrade',
        usage: 'wss://websocketocpp-production.up.railway.app/ocpp/{SERIAL}'
      }), {
        status: 426,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const serialNumber = url.pathname.split('/').pop();

    if (!serialNumber || serialNumber === 'ocpp') {
      return new Response(JSON.stringify({
        error: 'Serial required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const { socket, response } = Deno.upgradeWebSocket(req, {
      protocol: 'ocpp1.6'
    });

    socket.onopen = () => {
      console.log(`[WSS] Connected: ${serialNumber}`);
      activeConnections.set(serialNumber, socket);
    };

    socket.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);
        const [, , action] = message;

        console.log(`[WSS] ${serialNumber} → ${action}`);

        const res = await fetch(BASE44_PROCESS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serialNumber, message })
        });

        if (res.ok) {
          const result = await res.json();
          if (result.response) {
            socket.send(JSON.stringify(result.response));
          }
        }
      } catch (err) {
        console.error(`[WSS] Message error: ${err.message}`);
      }
    };

    socket.onclose = () => {
      console.log(`[WSS] Disconnected: ${serialNumber}`);
      activeConnections.delete(serialNumber);
    };

    socket.onerror = (err) => {
      console.error(`[WSS] Socket error: ${err}`);
    };

    return response;
  } catch (err) {
    console.error(`[WSS] Server error: ${err.message}`);
    return new Response(JSON.stringify({
      error: err.message
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});

console.log('🚀 Railway OCPP Server started');
