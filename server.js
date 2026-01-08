import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: process.env.PORT || 3000 });

wss.on('connection', (ws, req) => {
  const serialNumber = req.url.split('/').pop();
  
  ws.on('message', async (data) => {
    const message = JSON.parse(data.toString());
    
    // Chamar sua função Base44 via HTTP
    await fetch('https://targetecomobi.base44.app/api/functions/processOcppMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serialNumber,
        message
      })
    });
  });
});
