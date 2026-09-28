const mqtt = require('mqtt');
require('dotenv').config();
const { processUplinkMessage } = require('../services/readingService');

let client = null;

/**
 * Connect to ChirpStack MQTT broker and subscribe to uplink events.
 * If MQTT_BROKER is not explicitly set, MQTT is disabled and the system
 * relies on ChirpStack HTTP Webhook Integration (POST /api/readings/webhook).
 */
function connectMqtt() {
  const brokerUrl = process.env.MQTT_BROKER;

  // Skip MQTT entirely if no broker is configured (e.g. Railway cloud deployment).
  // Uplinks are received via ChirpStack HTTP Webhook instead.
  if (!brokerUrl || brokerUrl.trim() === '') {
    console.log('[MQTT] MQTT_BROKER not set — MQTT disabled. Using ChirpStack HTTP Webhook integration.');
    return null;
  }

  const topic = process.env.MQTT_TOPIC || 'application/+/device/+/event/up';

  const options = {
    clientId: `water-monitor-backend-${Math.random().toString(16).slice(2, 8)}`,
    clean: true,
    reconnectPeriod: 5000,    // retry every 5s on disconnect
    connectTimeout: 10000,
  };

  // Add credentials if provided
  if (process.env.MQTT_USERNAME) {
    options.username = process.env.MQTT_USERNAME;
    options.password = process.env.MQTT_PASSWORD || '';
  }

  console.log(`[MQTT] Connecting to broker: ${brokerUrl}`);
  console.log(`[MQTT] Topic: ${topic}`);

  client = mqtt.connect(brokerUrl, options);

  // ── Events ─────────────────────────────────────────────────────
  client.on('connect', () => {
    console.log('[MQTT] Connected to ChirpStack broker');

    client.subscribe(topic, { qos: 1 }, (err) => {
      if (err) {
        console.error('[MQTT] Subscribe error:', err.message);
      } else {
        console.log(`[MQTT] Subscribed to: ${topic}`);
      }
    });
  });

  client.on('message', async (receivedTopic, payload) => {
    console.log(`[MQTT] Message received on: ${receivedTopic}`);
    try {
      await processUplinkMessage(receivedTopic, payload);
    } catch (err) {
      console.error('[MQTT] Error processing message:', err.message);
    }
  });

  client.on('error', (err) => {
    console.error('[MQTT] Connection error:', err.message);
  });

  client.on('reconnect', () => {
    console.log('[MQTT] Reconnecting...');
  });

  client.on('offline', () => {
    console.warn('[MQTT] Client offline');
  });

  client.on('disconnect', () => {
    console.warn('[MQTT] Disconnected from broker');
  });

  return client;
}

/**
 * Gracefully disconnect from broker
 */
function disconnectMqtt() {
  if (client && client.connected) {
    client.end(true, () => {
      console.log('[MQTT] Disconnected gracefully');
    });
  }
}

/**
 * Get current connection status.
 * Returns 'disabled' when MQTT_BROKER is not configured (HTTP Webhook mode).
 */
function getMqttStatus() {
  if (!process.env.MQTT_BROKER || process.env.MQTT_BROKER.trim() === '') return 'disabled (webhook mode)';
  if (!client) return 'not_initialized';
  if (client.connected) return 'connected';
  if (client.reconnecting) return 'reconnecting';
  return 'disconnected';
}

module.exports = { connectMqtt, disconnectMqtt, getMqttStatus };
