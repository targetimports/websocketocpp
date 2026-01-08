import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: process.env.PORT || 3000 });

ws.on('message', async (data) => {
  const message = JSON.parse(data.toString());
  
  const response = await fetch('https://targetecomobi.base44.app/api/functions/processOcppMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serialNumber, message })
  });
  
  const result = await response.json();
  if (result.ocppResponse) {
    ws.send(JSON.stringify(result.ocppResponse));
  }
});

