import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 3000;

// 1) Servidor HTTP (para /monitor e qualquer rota simples)
const server = http.createServer((req, res) => {
  if (req.url === "/monitor") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
  }

  // opcional: resposta padrão
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("OK");
});

// 2) WebSocket acoplado ao mesmo server (upgrade)
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const serialNumber = req.url?.replace("/", "") || "UNKNOWN";
  console.log("WS conectado:", serialNumber);

  ws.on("message", async (data) => {
    try {
      const message = JSON.parse(data.toString());

      await fetch("https://targetecomobi.base44.app/api/functions/processOcppMessage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serialNumber, message }),
      });

      // ⚠️ OCPP costuma exigir resposta (dependendo da mensagem)
      // Aqui é só exemplo; o ideal é responder conforme o tipo [2, id, action, payload]
      // ws.send(JSON.stringify([3, message[1], {}]));
    } catch (err) {
      console.error("Erro ao processar mensagem:", err);
    }
  });

  ws.on("close", () => console.log("WS desconectado:", serialNumber));
  ws.on("error", (err) => console.error("WS erro:", serialNumber, err));
});

// 3) Escuta exatamente no PORT do Railway
server.listen(PORT, "0.0.0.0", () => {
  console.log(`HTTP+WS rodando na porta ${PORT}`);
});
