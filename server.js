import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 3000;

const wss = new WebSocketServer({ port: PORT });

console.log(`WebSocket OCPP rodando na porta ${PORT}`);

wss.on('connection', (ws, req) => {
  // Ex: ws://host:3000/CP_123456
  const serialNumber = req.url?.replace('/', '') || 'UNKNOWN';

  console.log('Conectado:', serialNumber);

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());

      console.log('Mensagem recebida:', serialNumber, message);

      await fetch(
        'https://targetecomobi.base44.app/api/functions/processOcppMessage',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            serialNumber,
            message
          })
        }
      );

    } catch (err) {
      console.error('Erro ao processar mensagem:', err);
    }
  });

  ws.on('close', () => {
    console.log('Desconectado:', serialNumber);
  });

  ws.on('error', (err) => {
    console.error('Erro WS:', serialNumber, err);
  });
});
