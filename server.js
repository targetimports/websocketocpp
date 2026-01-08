import { WebSocketServer } from 'ws';
import { createClient } from '@base44/sdk';

const PORT = process.env.PORT || 3000;
const wss = new WebSocketServer({ port: PORT });

const base44 = createClient({
  appId: process.env.BASE44_APP_ID,
  serviceRoleKey: process.env.BASE44_SERVICE_ROLE_KEY
});

const activeChargers = new Map();

wss.on('connection', (ws, req) => {
  const urlPath = req.url.split('/');
  const serialNumber = urlPath[urlPath.length - 1];
  
  console.log(`Charger connected: ${serialNumber}`);
  activeChargers.set(serialNumber, ws);
  
  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      console.log('Received:', message);
    } catch (err) {
      console.error('Invalid message', err.message);
    }
  });
  
  ws.on('close', () => {
    activeChargers.delete(serialNumber);
  });
});

console.log(`WebSocket server running on port ${PORT}`);
