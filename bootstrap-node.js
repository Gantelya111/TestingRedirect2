import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { mplex } from '@libp2p/mplex';
import { kadDHT } from '@libp2p/kad-dht';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { bootstrap } from '@libp2p/bootstrap';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import express from 'express';
import cors from 'cors';
import { multiaddr } from '@multiformats/multiaddr';
import { fromString as uint8ArrayFromString, toString as uint8ArrayToString } from 'uint8arrays';
import { WebSocketServer } from 'ws';
import http from 'http';
import { logger } from '@libp2p/logger';

// Локальний логер
const debugLogger = logger('bootstrap-node');

// Резервні адреси bootstrap-вузлів
const BOOTSTRAP_MULTIADDRS = [
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5i1FxheG2QeQcg3EsxS7bL63wQXoJYH'
];
const DHT_PUT_OPTIONS = { timeout: 60000 };
const KEY_PREFIX = '/redirect-p2p/entry/';
const topic = 'redirects-changes-v3';

let node;
let selectedMultiaddr;
const redirectsCache = new Map();

async function publishNodeAddress() {
  if (!node || node.status !== 'started' || !node.services.dht) {
    debugLogger('WARN: Cannot publish node address: node or DHT not ready');
    return;
  }

  const nodeKey = `/p2p-nodes/${node.peerId.toString()}`;
  const nodeValue = JSON.stringify({
    multiaddrs: node.getMultiaddrs().map(ma => ma.toString()),
    timestamp: Date.now()
  });

  try {
    await node.services.dht.put(
      uint8ArrayFromString(nodeKey),
      uint8ArrayFromString(nodeValue),
      DHT_PUT_OPTIONS
    );
    debugLogger('INFO: Published node address to DHT: %s', nodeKey);
  } catch (err) {
    debugLogger('ERROR: Failed to publish node address: %o', err);
  }
}

async function handlePubsubMessage(evt) {
  if (evt.detail.topic !== topic) {
    debugLogger('INFO: Ignoring message for topic: %s', evt.detail.topic);
    return;
  }

  try {
    const message = JSON.parse(uint8ArrayToString(evt.detail.data));
    debugLogger('INFO: Parsed PubSub message: %o', message);
    if (!message || !message.action || !message.shortCode) {
      debugLogger('WARN: Invalid PubSub message structure: %o', message);
      return;
    }

    const { action, shortCode, redirect } = message;
    debugLogger(`INFO: Handling PubSub action: ${action} for ${shortCode}`);

    switch (action) {
      case 'create':
      case 'update':
        if (redirect && redirect.destinationUrl) {
          const current = redirectsCache.get(shortCode) || {};
          const updatedRedirect = {
            ...current,
            ...redirect,
            passwordHash: current.passwordHash || redirect.passwordHash
          };
          redirectsCache.set(shortCode, updatedRedirect);
          debugLogger(`INFO: [PubSub] Cached ${action}: ${shortCode}, redirect: %o`, updatedRedirect);
          debugLogger('INFO: Updated redirectsCache size: %d', redirectsCache.size);
        } else {
          debugLogger(`WARN: [PubSub] Invalid redirect data for ${action}: ${shortCode}`);
        }
        break;
      case 'delete':
        if (redirectsCache.has(shortCode)) {
          redirectsCache.delete(shortCode);
          debugLogger(`INFO: [PubSub] Deleted redirect from cache: ${shortCode}`);
          debugLogger('INFO: Updated redirectsCache size: %d', redirectsCache.size);
        } else {
          debugLogger(`INFO: [PubSub] Redirect ${shortCode} not found in cache`);
        }
        break;
      default:
        debugLogger(`WARN: [PubSub] Unknown action: ${action}`);
    }
  } catch (error) {
    debugLogger(`ERROR: Error handling PubSub message: %o`, error);
  }
}

async function startBootstrapNode() {
  try {
    node = await createLibp2p({
      addresses: {
        listen: ['/ip4/0.0.0.0/tcp/0', '/ip4/0.0.0.0/tcp/0/ws']
      },
      transports: [
        tcp(),
        webSockets()
      ],
      connectionEncryption: [noise()],
      streamMuxers: [mplex()],
      peerDiscovery: [
        bootstrap({
          list: BOOTSTRAP_MULTIADDRS,
          timeout: 1000,
          tagName: 'bootstrap',
          tagValue: 50,
          tagTTL: 120000
        })
      ],
      services: {
        identify: identify(),
        dht: kadDHT({
          protocolPrefix: '/p2p-redirect',
          maxInboundStreams: 1000,
          maxOutboundStreams: 1000,
          clientMode: false
        }),
        pubsub: gossipsub({
          allowPublishToZeroTopicPeers: true,
          globalSignaturePolicy: 'StrictSign'
        }),
        circuitRelay: circuitRelayServer(),
        ping: ping()
      }
    });

    await node.start();
    debugLogger('INFO: Bootstrap node started with ID: %s', node.peerId.toString());

    const multiaddrs = node.getMultiaddrs().map(ma => ma.toString());
    debugLogger('INFO: Listening on: %o', multiaddrs);

    // Визначення TCP-порту з multiaddrs
    let tcpPort = 443; // За замовчуванням для продакшену
    const wsAddr = multiaddrs.find(addr => addr.includes('/ws'));
    if (wsAddr) {
      const match = wsAddr.match(/\/tcp\/(\d+)/);
      if (match) {
        tcpPort = match[1];
      }
    }
    debugLogger('INFO: Determined TCP port: %s', tcpPort);

    // Формування selectedMultiaddr
    const isProduction = process.env.NODE_ENV === 'production';
    const domain = isProduction ? 'libp2p.onrender.com' : 'localhost';
    selectedMultiaddr = `/dns4/${domain}/tcp/${tcpPort}/wss/ws/p2p/${node.peerId.toString()}`;
    debugLogger('INFO: Selected multiaddr: %s', selectedMultiaddr);

    // Підписка на PubSub для синхронізації редиректів
    if (node.services.pubsub) {
      node.services.pubsub.subscribe(topic);
      debugLogger('INFO: Subscribed to PubSub topic: %s', topic);
      node.services.pubsub.addEventListener('message', handlePubsubMessage);
    } else {
      debugLogger('WARN: PubSub service not available');
    }

    await publishNodeAddress();
    setInterval(publishNodeAddress, 5 * 60 * 1000);

    node.addEventListener('peer:discovery', (evt) => {
      debugLogger('INFO: Discovered peer: %s', evt.detail.id.toString());
    });
    node.addEventListener('peer:connect', (evt) => {
      debugLogger('INFO: Connected to peer: %s', evt.detail.toString());
    });

    return node;
  } catch (err) {
    debugLogger('ERROR: Failed to start bootstrap node: %o', err);
    throw err;
  }
}

// Створюємо Express-додаток
const app = express();
const server = http.createServer(app);

// Налаштування WebSocket
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  debugLogger('INFO: WebSocket client connected');
  if (node && node.status === 'started' && selectedMultiaddr) {
    ws.send(JSON.stringify({ status: 'ok', multiaddr: selectedMultiaddr }));
  } else {
    ws.send(JSON.stringify({ status: 'error', message: 'Bootstrap node not ready' }));
    debugLogger('WARN: WebSocket connection attempted but node not ready');
  }
  ws.on('message', (message) => {
    debugLogger('INFO: WebSocket message received: %s', message.toString());
    if (node && node.status === 'started' && selectedMultiaddr) {
      ws.send(JSON.stringify({ status: 'ok', multiaddr: selectedMultiaddr }));
    } else {
      ws.send(JSON.stringify({ status: 'error', message: 'Bootstrap node not ready' }));
    }
  });
  ws.on('error', (err) => {
    debugLogger('ERROR: WebSocket error: %o', err);
  });
  ws.on('close', () => {
    debugLogger('INFO: WebSocket client disconnected');
  });
});

// Налаштування CORS
app.use(cors({
  origin: ['https://libp2p.onrender.com', 'http://localhost:3000'],
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

// Парсинг JSON
app.use(express.json());

// Подаємо статичні файли
app.use(express.static('public'));

// Ендпоінт для перевірки стану
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    nodeStarted: !!(node && node.status === 'started'),
    selectedMultiaddr
  });
});

// Ендпоінт для bootstrap-адреси
app.get('/bootstrap-address', (req, res) => {
  if (node && node.status === 'started' && selectedMultiaddr) {
    debugLogger('INFO: Serving bootstrap address: %s', selectedMultiaddr);
    res.json({ multiaddr: selectedMultiaddr });
  } else {
    debugLogger('ERROR: Bootstrap node not started or multiaddr not set');
    res.status(500).json({ error: 'Bootstrap node not started' });
  }
});

// Ендпоінт для синхронізації редиректів
app.get('/redirects', (req, res) => {
  debugLogger('INFO: GET /redirects called, current redirectsCache size: %d', redirectsCache.size);
  const redirects = Array.from(redirectsCache.entries()).map(([shortCode, redirect]) => ({
    shortCode,
    destinationUrl: redirect.destinationUrl,
    description: redirect.description || '',
    createdAt: redirect.createdAt,
    updatedAt: redirect.updatedAt
  }));
  debugLogger('INFO: Serving redirects: %o', redirects);
  res.json(redirects);
});

// Запускаємо сервер
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  debugLogger('INFO: Server running on port %d', PORT);
  debugLogger('INFO: External WebSocket URL: ws://localhost:%d/ws', PORT);
  if (process.env.NODE_ENV === 'production') {
    debugLogger('INFO: Production WebSocket URL: wss://libp2p.onrender.com/ws');
  }
});

// Запускаємо bootstrap-вузол
startBootstrapNode().catch(err => {
  debugLogger('ERROR: Error starting bootstrap node: %o', err);
  process.exit(1);
});

// Обробка завершення процесу
process.on('SIGTERM', async () => {
  debugLogger('INFO: Received SIGTERM, shutting down...');
  if (node) {
    await node.stop();
    debugLogger('INFO: Bootstrap node stopped');
  }
  server.close(() => {
    debugLogger('INFO: HTTP server closed');
    process.exit(0);
  });
});