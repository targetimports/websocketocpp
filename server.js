/**
 * OCPP 1.6 WebSocket Server (WS e WSS)
 * Aceita conexões de carregadores via WS (não seguro) ou WSS (seguro)
 * Endpoint WS: ws://seu-dominio.base44.app/ocpp/{chargerSerialNumber}
 * Endpoint WSS: wss://seu-dominio.base44.app/ocpp/{chargerSerialNumber}
 */

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.4';

// Armazenar conexões ativas (em memória)
const activeConnections = new Map(); // Carregadores conectados
const clientConnections = new Set(); // Clientes de monitoramento conectados
const pendingCommands = new Map(); // Comandos pendentes por serial number

// Função para broadcast para todos os clientes de monitoramento
function broadcastToClients(message) {
  const messageStr = JSON.stringify(message);
  clientConnections.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(messageStr);
    }
  });
}

Deno.serve(async (req) => {
  const upgrade = req.headers.get("upgrade") || "";
  const url = new URL(req.url);
  
  if (upgrade.toLowerCase() !== "websocket") {
    const protocol = req.headers.get("x-forwarded-proto") === 'https' ? 'wss' : 'ws';
    return Response.json({ 
      error: 'Expected WebSocket upgrade',
      endpoint_ws: 'ws://' + req.headers.get("host") + '/ocpp/{chargerSerialNumber}',
      endpoint_wss: 'wss://' + req.headers.get("host") + '/ocpp/{chargerSerialNumber}',
      monitoring: protocol + '://' + req.headers.get("host") + '/ocpp/monitor',
      protocol: 'ocpp1.6',
      note: 'Use WS para carregadores sem suporte SSL, ou WSS para conexões seguras'
    }, { status: 426 });
  }

  const pathParts = url.pathname.split('/');
  const lastPathPart = pathParts[pathParts.length - 1];
  
  // Check if this is a monitoring client connection
  if (lastPathPart === 'monitor') {
    const { socket, response } = Deno.upgradeWebSocket(req);
    
    socket.onopen = () => {
      console.log('[MONITOR] 👀 Client connected for real-time monitoring');
      clientConnections.add(socket);
      
      // Send initial connection confirmation
      socket.send(JSON.stringify({
        type: 'connected',
        timestamp: new Date().toISOString(),
        activeChargers: Array.from(activeConnections.keys())
      }));
    };
    
    socket.onclose = () => {
      console.log('[MONITOR] Client disconnected');
      clientConnections.delete(socket);
    };
    
    socket.onerror = (error) => {
      console.error('[MONITOR] Error:', error);
      clientConnections.delete(socket);
    };
    
    return response;
  }
  
  const serialNumber = lastPathPart;

  if (!serialNumber || serialNumber === 'ocpp') {
    return Response.json({ 
      error: 'Charger serial number required in path',
      example_ws: 'ws://' + req.headers.get("host") + '/ocpp/CHARGER-123',
      example_wss: 'wss://' + req.headers.get("host") + '/ocpp/CHARGER-123'
    }, { status: 400 });
    }

    // Upgrade WebSocket with OCPP 1.6 subprotocol
    const { socket, response } = Deno.upgradeWebSocket(req, {
    protocol: 'ocpp1.6'
    });
    const base44 = createClientFromRequest(req);

  socket.onopen = async () => {
    const protocol = req.headers.get("x-forwarded-proto") === 'https' ? 'WSS' : 'WS';
    console.log(`[${protocol}] ✅ Charger ${serialNumber} connected via ${protocol === 'WSS' ? 'secure' : 'non-secure'} WebSocket`);
    activeConnections.set(serialNumber, socket);
    
    // Buscar carregador pelo serial number primeiro
    const chargers = await base44.asServiceRole.entities.Charger.filter({
      serial_number: serialNumber
    });
    
    const charger = chargers[0];
    if (!charger) {
      console.error(`[WSS] ❌ Charger with serial ${serialNumber} not found`);
      return;
    }
    
    // Buscar comandos pendentes (status 'queued') para este carregador
    try {
      const queuedLogs = await base44.asServiceRole.entities.OcppLog.filter({
        charger_id: charger.id,
        status: 'queued',
        direction: 'outgoing'
      });
      
      if (queuedLogs.length > 0) {
        console.log(`[WSS] 📦 Processing ${queuedLogs.length} queued commands for ${serialNumber}`);
        
        for (const log of queuedLogs) {
          const messageId = crypto.randomUUID();
          const ocppMessage = [2, messageId, log.message_type, log.payload || {}];
          
          console.log(`[WSS] 📤 Sending queued command to ${serialNumber}:`, log.message_type);
          socket.send(JSON.stringify(ocppMessage));
          
          // Atualizar log como enviado
          await base44.asServiceRole.entities.OcppLog.update(log.id, {
            status: 'sent'
          });
        }
      }
    } catch (error) {
      console.error(`[WSS] Error processing queued commands:`, error);
    }
    
    if (!charger) {
      console.error(`[WSS] ❌ Charger with serial ${serialNumber} not found in database`);
      await base44.asServiceRole.entities.OcppLog.create({
        charger_id: 'unknown',
        event_type: 'connection_error',
        message_type: 'connection_error',
        direction: 'incoming',
        payload: { 
          message: 'Charger not found in database',
          serial_number: serialNumber 
        },
        status: 'error',
        timestamp: new Date().toISOString()
      });
      return;
    }
    
    console.log(`[WSS] 🔍 Found charger in DB: ${charger.name} (${charger.id})`);
    
    try {
      await base44.asServiceRole.entities.Charger.update(charger.id, {
        is_online: true,
        last_heartbeat: new Date().toISOString(),
        status: 'Available'
      });

      await base44.asServiceRole.entities.OcppLog.create({
        charger_id: charger.id,
        event_type: 'connection',
        message_type: 'connection',
        direction: 'incoming',
        payload: { 
          message: 'WebSocket connected - waiting for BootNotification',
          serial_number: serialNumber
        },
        status: 'success',
        timestamp: new Date().toISOString()
      });
      
      console.log(`[WSS] ✅ Charger ${serialNumber} marked as online - waiting for BootNotification`);
      
      // Broadcast to monitoring clients
      broadcastToClients({
        type: 'charger_connected',
        data: {
          chargerId: charger.id,
          chargerName: charger.name,
          serialNumber: serialNumber,
          status: 'Available',
          timestamp: new Date().toISOString()
        }
      });
    } catch (error) {
      console.error(`[WSS] ❌ Error updating charger ${serialNumber}:`, error);
    }
  };

  socket.onmessage = async (event) => {
    try {
      const message = JSON.parse(event.data);
      const [messageTypeId, messageId, action, payload] = message;
      
      console.log(`[WS] 📨 Received from ${serialNumber}: ${action}`, payload);

      // Buscar carregador
      const chargers = await base44.asServiceRole.entities.Charger.filter({
        serial_number: serialNumber
      });
      const charger = chargers[0];
      if (!charger) {
        console.error(`[WSS] ❌ Charger ${serialNumber} not found when processing message`);
        return;
      }

      await base44.asServiceRole.entities.OcppLog.create({
        charger_id: charger.id,
        event_type: action || 'unknown',
        message_type: action || 'unknown',
        direction: 'incoming',
        payload: payload || {},
        status: 'success',
        message_id: messageId,
        timestamp: new Date().toISOString()
      });

      const response = await handleOcppMessage(base44, charger.id, message);
      
      if (response) {
        console.log(`[WS] 📤 Sending response to ${serialNumber}: ${action}Response`);
        socket.send(JSON.stringify(response));
        
        await base44.asServiceRole.entities.OcppLog.create({
          charger_id: charger.id,
          event_type: `${action}Response`,
          message_type: `${action}Response`,
          direction: 'outgoing',
          payload: response[2] || {},
          status: 'success',
          message_id: messageId,
          timestamp: new Date().toISOString()
        });
      }
    } catch (error) {
      console.error(`[WS] ❌ Error processing message from ${serialNumber}:`, error);
    }
  };

  socket.onclose = async () => {
    console.log(`[WS] Charger ${serialNumber} disconnected`);
    activeConnections.delete(serialNumber);
    
    try {
      const chargers = await base44.asServiceRole.entities.Charger.filter({
        serial_number: serialNumber
      });
      const charger = chargers[0];
      if (charger) {
        await base44.asServiceRole.entities.Charger.update(charger.id, {
          is_online: false,
          status: 'Unavailable'
        });

        await base44.asServiceRole.entities.OcppLog.create({
          charger_id: charger.id,
          event_type: 'disconnection',
          message_type: 'disconnection',
          direction: 'incoming',
          payload: { message: 'Charger disconnected' },
          status: 'success',
          timestamp: new Date().toISOString()
        });
        
        // Broadcast to monitoring clients
        broadcastToClients({
          type: 'charger_disconnected',
          data: {
            chargerId: charger.id,
            chargerName: charger.name,
            serialNumber: serialNumber,
            timestamp: new Date().toISOString()
          }
        });
      }
    } catch (error) {
      console.error(`[WS] Error updating charger ${serialNumber}:`, error);
    }
  };

  socket.onerror = (error) => {
    console.error(`[WS] Error with charger ${serialNumber}:`, error);
  };

  return response;
});

async function handleOcppMessage(base44, chargerId, message) {
  const [messageTypeId, messageId, action, payload] = message;

  // messageTypeId: 2 = CALL (request), 3 = CALLRESULT (response), 4 = CALLERROR
  if (messageTypeId === 2) {
    // Processar requisição do carregador
    const response = await processChargerRequest(base44, chargerId, action, payload);
    return [3, messageId, response]; // CALLRESULT
  }

  return null;
}

async function processChargerRequest(base44, chargerId, action, payload) {
  switch (action) {
    case 'BootNotification':
      return await handleBootNotification(base44, chargerId, payload);
    
    case 'Heartbeat':
      return await handleHeartbeat(base44, chargerId);
    
    case 'StatusNotification':
      return await handleStatusNotification(base44, chargerId, payload);
    
    case 'StartTransaction':
      return await handleStartTransaction(base44, chargerId, payload);
    
    case 'StopTransaction':
      return await handleStopTransaction(base44, chargerId, payload);
    
    case 'MeterValues':
      return await handleMeterValues(base44, chargerId, payload);
    
    default:
      return { status: 'Rejected' };
  }
}

async function handleBootNotification(base44, chargerId, payload) {
  const { chargePointVendor, chargePointModel, firmwareVersion } = payload;
  
  console.log(`[OCPP] 🚀 BootNotification received for charger ${chargerId}:`, payload);
  
  const charger = await base44.asServiceRole.entities.Charger.update(chargerId, {
    manufacturer: chargePointVendor,
    model: chargePointModel,
    firmware_version: firmwareVersion,
    is_online: true,
    status: 'Available',
    last_heartbeat: new Date().toISOString()
  });

  console.log(`[OCPP] ✅ BootNotification processed - charger is now fully online`);
  
  // Broadcast boot notification to monitoring clients
  broadcastToClients({
    type: 'charger_boot',
    data: {
      chargerId: charger.id,
      chargerName: charger.name,
      status: 'Available',
      isOnline: true,
      timestamp: new Date().toISOString()
    }
  });

  return {
    status: 'Accepted',
    currentTime: new Date().toISOString(),
    interval: 30 // Heartbeat interval in seconds (30s)
  };
}

async function handleHeartbeat(base44, chargerId) {
  const charger = await base44.asServiceRole.entities.Charger.update(chargerId, {
    last_heartbeat: new Date().toISOString(),
    is_online: true
  });
  
  // Broadcast heartbeat to monitoring clients (every 30s)
  broadcastToClients({
    type: 'heartbeat',
    data: {
      chargerId: charger.id,
      timestamp: new Date().toISOString()
    }
  });

  return {
    currentTime: new Date().toISOString()
  };
}

async function handleStatusNotification(base44, chargerId, payload) {
  const { status, errorCode, connectorId } = payload;
  
  const charger = await base44.asServiceRole.entities.Charger.update(chargerId, {
    status: status,
    error_code: errorCode || 'NoError',
    last_heartbeat: new Date().toISOString()
  });
  
  // Broadcast status update to monitoring clients
  broadcastToClients({
    type: 'charger_status_update',
    data: {
      chargerId: charger.id,
      chargerName: charger.name,
      status: status,
      errorCode: errorCode || 'NoError',
      connectorId: connectorId,
      timestamp: new Date().toISOString()
    }
  });
  
  // Send critical fault notification
  if (status === 'Faulted') {
    broadcastToClients({
      type: 'charger_fault',
      data: {
        chargerId: charger.id,
        chargerName: charger.name,
        errorCode: errorCode || 'UnknownError',
        timestamp: new Date().toISOString()
      }
    });
  }

  return {}; // Empty response for StatusNotification
}

async function handleStartTransaction(base44, chargerId, payload) {
  const { connectorId, idTag, meterStart, timestamp } = payload;
  
  const transactionId = Date.now();
  
  // Criar sessão de carregamento
  const session = await base44.asServiceRole.entities.ChargingSession.create({
    charger_id: chargerId,
    connector_id: connectorId,
    transaction_id: transactionId.toString(),
    id_tag: idTag,
    start_time: timestamp || new Date().toISOString(),
    meter_start: meterStart,
    status: 'Active',
    price_per_kwh: 0.8,
    energy_kwh: 0,
    cost: 0
  });

  // Atualizar status do carregador
  const charger = await base44.asServiceRole.entities.Charger.update(chargerId, {
    status: 'Charging',
    last_heartbeat: new Date().toISOString()
  });
  
  // Broadcast transaction start to monitoring clients
  broadcastToClients({
    type: 'transaction_started',
    data: {
      chargerId: charger.id,
      chargerName: charger.name,
      sessionId: session.id,
      transactionId: transactionId.toString(),
      connectorId: connectorId,
      timestamp: timestamp || new Date().toISOString()
    }
  });

  return {
    transactionId: transactionId,
    idTagInfo: {
      status: 'Accepted'
    }
  };
}

async function handleStopTransaction(base44, chargerId, payload) {
  const { transactionId, meterStop, timestamp, reason } = payload;
  
  // Buscar sessão ativa
  const sessions = await base44.asServiceRole.entities.ChargingSession.filter({
    charger_id: chargerId,
    transaction_id: transactionId.toString()
  });

  if (sessions.length > 0) {
    const session = sessions[0];
    const energyKwh = (meterStop - session.meter_start) / 1000;
    const cost = energyKwh * (session.price_per_kwh || 0.8);

    await base44.asServiceRole.entities.ChargingSession.update(session.id, {
      end_time: timestamp || new Date().toISOString(),
      meter_stop: meterStop,
      energy_kwh: energyKwh,
      cost: cost,
      status: 'Completed',
      stop_reason: reason || 'Local'
    });

    // Atualizar totais do cliente se existir
    if (session.customer_id) {
      const customer = await base44.asServiceRole.entities.Customer.get(session.customer_id);
      if (customer) {
        await base44.asServiceRole.entities.Customer.update(session.customer_id, {
          total_energy_kwh: (customer.total_energy_kwh || 0) + energyKwh,
          total_sessions: (customer.total_sessions || 0) + 1,
          balance: (customer.balance || 0) - cost
        });
      }
    }
  }

  // Atualizar status do carregador
  await base44.asServiceRole.entities.Charger.update(chargerId, {
    status: 'Available',
    last_heartbeat: new Date().toISOString()
  });

  return {
    idTagInfo: {
      status: 'Accepted'
    }
  };
}

async function handleMeterValues(base44, chargerId, payload) {
  const { connectorId, transactionId, meterValue } = payload;
  
  if (transactionId) {
    // Buscar sessão ativa
    const sessions = await base44.asServiceRole.entities.ChargingSession.filter({
      charger_id: chargerId,
      transaction_id: transactionId.toString()
    });

    if (sessions.length > 0) {
      const session = sessions[0];
      
      // Extrair valor de energia das leituras
      const sampledValues = meterValue[0]?.sampledValue || [];
      const energyReading = sampledValues.find(v => v.measurand === 'Energy.Active.Import.Register');
      
      if (energyReading) {
        const currentMeter = parseInt(energyReading.value);
        const energyKwh = (currentMeter - session.meter_start) / 1000;
        const cost = energyKwh * (session.price_per_kwh || 0.8);

        await base44.asServiceRole.entities.ChargingSession.update(session.id, {
          energy_kwh: energyKwh,
          cost: cost
        });
        
        // Broadcast meter values to monitoring clients
        const charger = await base44.asServiceRole.entities.Charger.get(chargerId);
        broadcastToClients({
          type: 'meter_values',
          data: {
            chargerId: charger.id,
            chargerName: charger.name,
            sessionId: session.id,
            transactionId: transactionId.toString(),
            energyKwh: energyKwh,
            cost: cost,
            timestamp: new Date().toISOString()
          }
        });
      }
    }
  }

  return {}; // Empty response for MeterValues
}

// Função para enviar comandos remotos para o carregador
export function sendToCharger(serialNumber, message) {
  const socket = activeConnections.get(serialNumber);
  
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    throw new Error('Charger not connected');
  }

  socket.send(JSON.stringify(message));
  
  return {
    status: 'sent',
    message: 'Command sent to charger via WSS'
  };
}
