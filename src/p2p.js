import { createLibp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { webRTC } from '@libp2p/webrtc';
import { mplex } from '@libp2p/mplex';
import { noise } from '@chainsafe/libp2p-noise';
import { kadDHT } from '@libp2p/kad-dht';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { bootstrap } from '@libp2p/bootstrap';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { fromString as uint8ArrayFromString, toString as uint8ArrayToString } from 'uint8arrays';
import { multiaddr } from '@multiformats/multiaddr';
import { logger } from '@libp2p/logger';
import { createHash } from 'crypto';

// Локальний логер
const debugLogger = logger('p2p-app');

// Перевірка середовища
const isSecureContext = typeof window !== 'undefined' && window.isSecureContext;
const isCryptoAvailable = typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.digest === 'function';
const isLocalhost = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
const isHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';
debugLogger('INFO: Environment check - SecureContext: %o, CryptoAvailable: %o, Localhost: %o, HTTPS: %o',
    isSecureContext, isCryptoAvailable, isLocalhost, isHttps);

if (!isHttps && !isLocalhost) {
    debugLogger('WARN: Running on HTTP (not localhost). Consider using HTTPS for full functionality.');
}

let node;
const redirectsCache = new Map();
const topic = 'redirects-changes-v3';
const REPUBLISH_INTERVAL_MS = 10 * 60 * 1000;
const DHT_PUT_OPTIONS = { timeout: 10000 };
const DHT_GET_OPTIONS = { timeout: 5000 };
const MAX_SHORTCODE_GENERATION_ATTEMPTS = 15;
const KEY_PREFIX = '/redirect-p2p/entry/';
const STATIC_FILES_PROTOCOL = '/static-files/1.0.0';

let republishIntervalId = null;
let nodeInitializationStatus = 'idle';
let startNodePromise = null;
let pollingIntervalId = null;

// Зберігання redirectsCache у localStorage
function saveRedirectsCacheToLocalStorage() {
    try {
        const cacheObject = {};
        for (const [key, value] of redirectsCache) {
            cacheObject[key] = value;
        }
        localStorage.setItem('redirectsCache', JSON.stringify(cacheObject));
        debugLogger('INFO: Saved redirectsCache to localStorage: %o', cacheObject);
    } catch (err) {
        debugLogger(`ERROR: Failed to save redirectsCache to localStorage:`, err);
    }
}

// Відновлення redirectsCache із localStorage
function loadRedirectsCacheFromLocalStorage() {
    try {
        const cacheData = localStorage.getItem('redirectsCache');
        if (cacheData) {
            const cacheObject = JSON.parse(cacheData);
            for (const key in cacheObject) {
                if (cacheObject.hasOwnProperty(key)) {
                    redirectsCache.set(key, cacheObject[key]);
                }
            }
            debugLogger('INFO: Loaded redirectsCache from localStorage: %o', cacheObject);
        } else {
            debugLogger('INFO: No redirectsCache found in localStorage');
        }
    } catch (err) {
        debugLogger(`ERROR: Failed to load redirectsCache from localStorage:`, err);
    }
}

// Очищення старих даних
function clearOldRedirectData() {
    try {
        for (const key in localStorage) {
            if (key.startsWith('redirect_') && key.endsWith('_hash')) {
                localStorage.removeItem(key);
                debugLogger(`INFO: Removed old redirect data: ${key}`);
            }
        }
    } catch (err) {
        debugLogger(`ERROR: Failed to clear old redirect data:`, err);
    }
}

clearOldRedirectData();
loadRedirectsCacheFromLocalStorage();

/**
 * Публікація адреси вузла в DHT
 */
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

/**
 * Пошук адрес інших вузлів у DHT
 * @returns {Promise<string[]>}
 */
async function discoverNodesFromDHT() {
    if (!node || !node.services.dht) {
        debugLogger('WARN: Cannot discover nodes: node or DHT not ready');
        return [];
    }

    const nodeAddresses = [];
    const prefix = '/p2p-nodes/';

    try {
        for await (const provider of node.services.dht.findProviders(uint8ArrayFromString(prefix), DHT_GET_OPTIONS)) {
            const key = `/p2p-nodes/${provider.id.toString()}`;
            try {
                const value = await node.services.dht.get(uint8ArrayFromString(key), DHT_GET_OPTIONS);
                const nodeData = JSON.parse(uint8ArrayToString(value));
                if (nodeData.multiaddrs && Array.isArray(nodeData.multiaddrs)) {
                    nodeAddresses.push(...nodeData.multiaddrs);
                    debugLogger('INFO: Discovered node: %s with addresses: %o', key, nodeData.multiaddrs);
                }
            } catch (err) {
                debugLogger('ERROR: Failed to fetch node data for %s: %o', key, err);
            }
        }
    } catch (err) {
        debugLogger('ERROR: Failed to discover nodes from DHT: %o', err);
    }

    return nodeAddresses;
}

/**
 * Запит статичного файлу від іншого вузла
 * @param {string} filePath
 * @returns {Promise<string|null>}
 */
async function requestStaticFile(filePath) {
    if (!node || !node.services.dht) {
        debugLogger('WARN: Cannot request static file: node or DHT not ready');
        return null;
    }

    const fileKey = `/static-files/${filePath}`;
    try {
        const contentBytes = await node.services.dht.get(uint8ArrayFromString(fileKey), DHT_GET_OPTIONS);
        if (contentBytes) {
            const content = uint8ArrayToString(contentBytes);
            localStorage.setItem(`site-file:${filePath}`, content);
            debugLogger('INFO: Fetched static file %s from DHT', filePath);
            return content;
        }
    } catch (err) {
        debugLogger('ERROR: Failed to fetch static file %s: %o', filePath, err);
    }

    let providers;
    try {
        providers = [];
        for await (const provider of node.services.dht.findProviders(uint8ArrayFromString(fileKey), DHT_GET_OPTIONS)) {
            providers.push(provider);
        }
        if (!providers.length) {
            debugLogger('WARN: No providers found for file %s', filePath);
            return null;
        }
    } catch (err) {
        debugLogger('ERROR: Failed to find providers for file %s: %o', filePath, err);
        return null;
    }

    for (const provider of providers) {
        try {
            const stream = await node.dialProtocol(provider.id, STATIC_FILES_PROTOCOL);
            await stream.sink(uint8ArrayFromString(filePath));
            const response = [];
            for await (const chunk of stream.source) {
                response.push(chunk.slice());
            }
            const content = uint8ArrayToString(response[0]);
            localStorage.setItem(`site-file:${filePath}`, content);
            debugLogger('INFO: Fetched static file %s from peer %s', filePath, provider.id.toString());
            return content;
        } catch (err) {
            debugLogger('ERROR: Failed to fetch static file %s from peer %s: %o', filePath, provider.id.toString(), err);
        }
    }

    return null;
}

/**
 * Завантаження критичного файлу (index.html) з P2P мережі
 */
async function loadSiteFromP2P() {
    const criticalFile = 'index.html';
    if (!localStorage.getItem(`site-file:${criticalFile}`)) {
        const content = await requestStaticFile(criticalFile);
        if (!content) {
            debugLogger('ERROR: Failed to load critical file %s', criticalFile);
            updateP2PStatus(`Failed to load ${criticalFile}`, true);
            return false;
        }
    }

    const indexContent = localStorage.getItem(`site-file:${criticalFile}`);
    if (indexContent) {
        document.open();
        document.write(indexContent);
        document.close();
        debugLogger('INFO: Loaded index.html from P2P network');
        updateP2PStatus('Index loaded from P2P network');
        return true;
    }

    debugLogger('ERROR: Failed to load index.html');
    updateP2PStatus('Failed to load index.html', true);
    return false;
}

/**
 * Завантаження некритичних файлів у фоновому режимі
 */
async function loadNonCriticalFiles() {
    const nonCriticalFiles = [
        'p2p.js',
        'manager.js',
        'edit-redirect.js',
        'p2p-app.js',
        'polyfills.js'
    ];

    for (const file of nonCriticalFiles) {
        if (!localStorage.getItem(`site-file:${file}`)) {
            const content = await requestStaticFile(file);
            if (content) {
                debugLogger('INFO: Fetched background file %s', file);
            }
        }
    }
}

/**
 * Публікація статичних файлів у DHT
 */
async function publishStaticFiles() {
    if (!node || !node.services.dht) {
        debugLogger('WARN: Cannot publish static files: node or DHT not ready');
        return;
    }

    const staticFiles = [
        { path: 'index.html', key: '/static-files/index.html' }
    ];

    for (const file of staticFiles) {
        const content = localStorage.getItem(`site-file:${file.path}`);
        if (content) {
            try {
                await node.services.dht.put(
                    uint8ArrayFromString(file.key),
                    uint8ArrayFromString(content),
                    DHT_PUT_OPTIONS
                );
                debugLogger('INFO: Published static file to DHT: %s', file.key);
            } catch (err) {
                debugLogger('ERROR: Failed to publish static file %s: %o', file.key, err);
            }
        }
    }

    setInterval(async () => {
        const allFiles = [
            { path: 'index.html', key: '/static-files/index.html' },
            { path: 'p2p.js', key: '/static-files/p2p.js' },
            { path: 'manager.js', key: '/static-files/manager.js' },
            { path: 'edit-redirect.js', key: '/static-files/edit-redirect.js' },
            { path: 'p2p-app.js', key: '/static-files/p2p-app.js' },
            { path: 'polyfills.js', key: '/static-files/polyfills.js' }
        ];
        for (const file of allFiles) {
            const content = localStorage.getItem(`site-file:${file.path}`);
            if (content) {
                node.services.dht.put(
                    uint8ArrayFromString(file.key),
                    uint8ArrayFromString(content),
                    DHT_PUT_OPTIONS
                ).catch(err => {
                    debugLogger('ERROR: Failed to republish static file %s: %o', file.key, err);
                });
            }
        }
    }, 5 * 60 * 1000);
}

/**
 * Отримання адреси bootstrap-вузла з автоматичним визначенням портів
 * @returns {Promise<string[]>}
 */
async function fetchBootstrapAddress(peerId = null) {
    const isLocalhost = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
    const domain = isLocalhost ? 'localhost' : 'libp2p.onrender.com';
    const port = isLocalhost ? (process.env.PORT || 3000) : 443;
    const bootstrapUrl = isLocalhost
        ? `http://${domain}:${port}/bootstrap-address`
        : `https://${domain}/bootstrap-address`;
    const fallbackMultiaddrs = [
        '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
        '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5i1FxheG2QeQcg3EsxS7bL63wQXoJYH',
        '/dnsaddr/bootstrap.libp2p.io/p2p/QmZa1sAxajnQjxtWGTx3qZCo2X6YppJxtEEsB7kY1kTphk',
        '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa'
    ];

    try {
        debugLogger('INFO: Fetching bootstrap address from %s', bootstrapUrl);
        const response = await fetch(bootstrapUrl, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) {
            throw new Error(`HTTP error: ${response.status}`);
        }
        const data = await response.json();
        if (data.multiaddr) {
            debugLogger('INFO: Received bootstrap address: %s', data.multiaddr);
            return [data.multiaddr, ...fallbackMultiaddrs];
        } else {
            debugLogger('WARN: No multiaddr in response: %o', data);
            return fallbackMultiaddrs;
        }
    } catch (err) {
        debugLogger('ERROR: Failed to fetch bootstrap address: %o', err);
        return fallbackMultiaddrs;
    }
}

/**
 * HTTP Polling для синхронізації редиректів (резервний механізм)
 */
async function syncRedirectsViaPolling() {
    if (!isHttps && !isLocalhost) {
        debugLogger('WARN: HTTP polling disabled in non-HTTPS environment');
        return;
    }
    try {
        debugLogger('INFO: Starting HTTP polling to https://libp2p.onrender.com/redirects');
        const response = await fetch('https://libp2p.onrender.com/redirects', { signal: AbortSignal.timeout(5000) });
        debugLogger('INFO: Polling response status: %d', response.status);
        if (!response.ok) {
            throw new Error(`HTTP error: ${response.status}`);
        }
        const redirects = await response.json();
        debugLogger('INFO: Polling fetched redirects: %o', redirects);
        redirects.forEach(r => {
            if (r.shortCode && r.destinationUrl) {
                redirectsCache.set(r.shortCode, r);
            }
        });
        saveRedirectsCacheToLocalStorage();
        debugLogger('INFO: Synced redirects via HTTP polling');
        updateP2PStatus('Synced redirects via polling');
    } catch (err) {
        debugLogger('ERROR: Failed to sync redirects via polling: %o', err);
        updateP2PStatus('Failed to sync redirects via polling', true);
    }
}

/**
 * Оновлення статусу P2P у UI
 * @param {string} status - Статус
 * @param {boolean} isError - Чи є помилкою
 */
function updateP2PStatus(status, isError = false) {
    debugLogger(`INFO: Updating P2P status: ${status}, isError: ${isError}`);
    const statusElement = document.getElementById('p2p-status');
    if (statusElement) {
        statusElement.textContent = `P2P Status: ${status}`;
        statusElement.style.color = isError ? 'red' : 'green';
        debugLogger(`INFO: P2P Status set in UI: ${status}`);
    } else {
        debugLogger(`INFO: P2P Status (UI element not found): ${status}`);
    }
}

/**
 * Запуск Libp2p вузла з прискореною ініціалізацією
 * @returns {Promise<import('libp2p').Libp2p>}
 */
async function startNodeInternal() {
    debugLogger("INFO: Starting node initialization");
    if (node && node.status === 'started') {
        debugLogger("INFO: Node already started");
        updateP2PStatus('Already started');
        return node;
    }
    if (nodeInitializationStatus === 'starting') {
        debugLogger("INFO: Node initialization in progress");
        updateP2PStatus('Initialization in progress...');
        return startNodePromise;
    }

    nodeInitializationStatus = 'starting';
    updateP2PStatus('Initializing node...');

    try {
        // Початкові bootstrap-адреси
        debugLogger("INFO: Fetching initial bootstrap addresses...");
        let bootstrapMultiaddrs = await fetchBootstrapAddress();
        debugLogger('INFO: Initial bootstrap addresses: %o', bootstrapMultiaddrs);

        // Функція фільтрації для WebSocket-адрес
        const wsFilter = (multiaddr) => {
            let addrStr = multiaddr.toString();
            debugLogger('INFO: Original WebSocket multiaddr: %s', addrStr);

            if (!isLocalhost && addrStr.includes('ws://')) {
                addrStr = addrStr.replace('ws://', 'wss://');
                debugLogger('INFO: Replaced ws:// with wss://: %s', addrStr);
            }

            if (addrStr.includes('/wss') && !addrStr.includes('/ws/')) {
                addrStr = addrStr.replace('/wss', '/wss/ws');
                debugLogger('INFO: Added /ws to WebSocket multiaddr: %s', addrStr);
            }

            if (addrStr.includes('wss//')) {
                addrStr = addrStr.replace('wss//', 'wss/');
                debugLogger('INFO: Fixed wss// to wss/: %s', addrStr);
            }

            debugLogger('INFO: Final WebSocket multiaddr: %s', addrStr);
            return multiaddr(addrStr);
        };

        // Конфігурація Libp2p
        const config = {
            addresses: {
                listen: [] // У браузері TCP-адреси не потрібні
            },
            transports: [
                webSockets({
                    filter: wsFilter
                }),
                webRTC({
                    rtcConfiguration: {
                        iceServers: [
                            { urls: 'stun:stun.l.google.com:19302' },
                            { urls: 'stun:stun1.l.google.com:19302' }
                        ]
                    }
                }),
                circuitRelayTransport()
            ],
            streamMuxers: [mplex()],
            connectionEncryption: [noise()],
            peerDiscovery: [
                bootstrap({
                    list: bootstrapMultiaddrs,
                    interval: 10000,
                    enabled: true
                })
            ],
            services: {
                dht: kadDHT({
                    clientMode: true,
                    protocol: '/p2p-redirect/kad/1.0.0',
                    enabled: isCryptoAvailable
                }),
                pubsub: gossipsub({
                    allowPublishToZeroPeers: true,
                    emitSelf: true
                }),
                identify: identify(),
                ping: ping()
            },
            connectionManager: {
                minConnections: 0,
                maxConnections: 50
            }
        };
        debugLogger("INFO: Libp2p config: %o", config);

        // Створення вузла
        debugLogger("INFO: Creating Libp2p node...");
        node = await createLibp2p(config);
        debugLogger("INFO: Libp2p node created with ID: %s", node.peerId.toString());

        // Додаємо обробник помилок вузла
        node.addEventListener('error', (evt) => {
            const err = evt.detail;
            debugLogger('ERROR: Libp2p node error: %o', err);
            updateP2PStatus(`Node error: ${err.message}`, true);
        });

        // Реєстрація обробника для статичних файлів
        node.handle(STATIC_FILES_PROTOCOL, async ({ stream, connection }) => {
            try {
                const filePath = uint8ArrayToString((await stream.source.next()).value.slice());
                const content = localStorage.getItem(`site-file:${filePath}`);
                if (content) {
                    await stream.sink([uint8ArrayFromString(content)]);
                    debugLogger('INFO: Served static file %s to peer %s', filePath, connection.remotePeer.toString());
                } else {
                    await stream.close();
                    debugLogger('WARN: File %s not found for peer %s', filePath, connection.remotePeer.toString());
                }
            } catch (err) {
                debugLogger('ERROR: Failed to handle static file request: %o', err);
                await stream.close();
            }
        });

        // Додаємо обробники подій
        node.addEventListener('peer:discovery', (evt) => {
            const peerId = evt.detail.id ? evt.detail.id.toString() : 'unknown';
            const multiaddrs = evt.detail.multiaddrs.map(ma => ma.toString());
            debugLogger('INFO: Discovered peer: %s with multiaddrs: %o', peerId, multiaddrs);
            updateP2PStatus(`Discovered peer: ${peerId.substring(0, 10)}...`);
        });
        node.addEventListener('peer:connect', (evt) => {
            const peerId = evt.detail.toString();
            debugLogger('INFO: Connected to peer: %s', peerId);
            updateP2PStatus(`Connected to peer: ${peerId.substring(0, 10)}...`);
            for (const [shortCode, redirect] of redirectsCache) {
                const safeRedirect = {
                    destinationUrl: redirect.destinationUrl,
                    description: redirect.description,
                    createdAt: redirect.createdAt,
                    updatedAt: redirect.updatedAt
                };
                const message = { action: 'create', shortCode, redirect: safeRedirect };
                node.services.pubsub.publish(
                    topic,
                    uint8ArrayFromString(JSON.stringify(message))
                ).catch(err => debugLogger(`ERROR: Failed to publish redirect ${shortCode}: %o`, err));
            }
        });
        node.addEventListener('peer:disconnect', (evt) => {
            const peerId = evt.detail.toString();
            debugLogger('INFO: Disconnected from peer: %s', peerId);
            updateP2PStatus(`Disconnected from peer: ${peerId.substring(0, 10)}...`);
        });

        // Запуск вузла
        debugLogger('INFO: Starting Libp2p node...');
        await node.start();
        nodeInitializationStatus = 'started';
        debugLogger('INFO: Libp2p node started with ID: %s', node.peerId.toString());
        const multiaddrs = node.getMultiaddrs().map(ma => ma.toString());
        debugLogger('INFO: Node addresses: %o', multiaddrs);
        debugLogger('INFO: DHT enabled: %o', !!node.services.dht);

        if (multiaddrs.length === 0) {
            debugLogger('WARN: No multiaddrs assigned to node, operating in isolated mode');
            updateP2PStatus('No addresses assigned, isolated mode', true);
        }

        // Паралельне виконання критичних операцій
        const criticalPromises = [];

        // 1. Підключення до bootstrap-вузлів
        debugLogger('INFO: Dialing bootstrap nodes: %o', bootstrapMultiaddrs);
        updateP2PStatus('Connecting to network...');
        let successfulConnections = 0;
        const dialPromises = bootstrapMultiaddrs.map(async (addr) => {
            try {
                const ma = multiaddr(addr);
                debugLogger('INFO: Attempting to dial bootstrap node: %s', addr);
                await node.dial(ma, { timeout: 5000 });
                debugLogger('INFO: Successfully dialed bootstrap node: %s', addr);
                successfulConnections++;
            } catch (err) {
                debugLogger('ERROR: Failed to dial bootstrap node %s: %o', addr, err);
            }
        });
        criticalPromises.push(Promise.all(dialPromises));

        // 2. Публікація адреси вузла
        criticalPromises.push(publishNodeAddress());

        // 3. Завантаження index.html
        criticalPromises.push(loadSiteFromP2P());

        // 4. Публікація статичних файлів
        criticalPromises.push(publishStaticFiles());

        // 5. Підписка на PubSub
        if (node.services.pubsub) {
            await node.services.pubsub.subscribe(topic);
            debugLogger("INFO: Subscribed to PubSub topic: %s", topic);
            node.services.pubsub.addEventListener('message', handlePubsubMessage);
            updateP2PStatus('PubSub subscribed');
        } else {
            debugLogger('ERROR: PubSub service is not available, falling back to HTTP polling');
            updateP2PStatus('PubSub unavailable, using HTTP polling', true);
            startPolling();
        }

        // Очікування завершення критичних операцій
        await Promise.all(criticalPromises);

        // Спроба підключення до вузлів із DHT
        if (successfulConnections === 0) {
            debugLogger('WARN: No bootstrap nodes connected, attempting DHT discovery');
            const dhtAddrs = await discoverNodesFromDHT();
            if (dhtAddrs.length > 0) {
                const dhtDialPromises = dhtAddrs.map(async (addr) => {
                    try {
                        const ma = multiaddr(addr);
                        debugLogger('INFO: Attempting to dial DHT node: %s', addr);
                        await node.dial(ma, { timeout: 5000 });
                        debugLogger('INFO: Successfully dialed DHT node: %s', addr);
                        successfulConnections++;
                    } catch (err) {
                        debugLogger('ERROR: Failed to dial DHT node %s: %o', addr, err);
                    }
                });
                await Promise.all(dhtDialPromises);
            }
        }

        if (successfulConnections === 0) {
            debugLogger("WARN: No connections established, enabling HTTP polling");
            updateP2PStatus('No network connection, using HTTP polling', true);
            startPolling();
        } else {
            debugLogger('INFO: Connected to %d node(s)', successfulConnections);
            updateP2PStatus(`Connected to ${successfulConnections} node(s)`);
        }

        // Запуск періодичного перепідключення
        startRepublishing();

        // Фонові операції
        setTimeout(() => {
            setInterval(publishNodeAddress, 2 * 60 * 1000);
            setInterval(async () => {
                const newAddrs = await discoverNodesFromDHT();
                for (const addr of newAddrs) {
                    try {
                        const ma = multiaddr(addr);
                        debugLogger('INFO: Attempting to dial discovered node: %s', addr);
                        await node.dial(ma, { timeout: 5000 });
                        debugLogger('INFO: Successfully dialed discovered node: %s', addr);
                    } catch (err) {
                        debugLogger('ERROR: Failed to dial discovered node %s: %o', addr, err);
                    }
                }
            }, 5 * 60 * 1000);
            loadNonCriticalFiles();
        }, 1000);

        debugLogger("INFO: Node initialization completed");
        updateP2PStatus('Ready');
        return node;
    } catch (error) {
        debugLogger(`ERROR: Node initialization failed: %o`, error);
        nodeInitializationStatus = 'failed';
        updateP2PStatus(`Failed to start: ${error.message}`, true);
        node = null;
        startPolling();
        throw error;
    }
}

/**
 * Запуск HTTP polling як резервного механізму
 */
function startPolling() {
    if (pollingIntervalId) {
        clearInterval(pollingIntervalId);
    }
    syncRedirectsViaPolling();
    pollingIntervalId = setInterval(syncRedirectsViaPolling, 5 * 1000);
    debugLogger('INFO: Started HTTP polling for redirect synchronization with 5s interval');
}

startNodePromise = startNodeInternal();

async function stopNode() {
    debugLogger("INFO: Stopping node");
    if (republishIntervalId) {
        clearInterval(republishIntervalId);
        republishIntervalId = null;
        debugLogger("INFO: Stopped republishing interval");
    }
    if (pollingIntervalId) {
        clearInterval(pollingIntervalId);
        pollingIntervalId = null;
        debugLogger("INFO: Stopped polling interval");
    }
    if (node && node.status === 'started') {
        try {
            await node.stop();
            debugLogger("INFO: Libp2p node stopped");
            updateP2PStatus('Stopped');
        } catch (error) {
            debugLogger(`ERROR: Error stopping node: %o`, error);
            updateP2PStatus('Error stopping node', true);
        } finally {
            node = null;
            nodeInitializationStatus = 'idle';
            startNodePromise = null;
            redirectsCache.clear();
            localStorage.removeItem('redirectsCache');
            clearOldRedirectData();
            debugLogger("INFO: Node resources cleaned up");
        }
    } else {
        node = null;
        nodeInitializationStatus = 'idle';
        startNodePromise = null;
        redirectsCache.clear();
        localStorage.removeItem('redirectsCache');
        clearOldRedirectData();
        debugLogger("INFO: Node was not running, cleaned up resources");
    }
}

async function handlePubsubMessage(evt) {
    debugLogger("INFO: Received PubSub message for topic: %s", evt.detail.topic);
    if (evt.detail.topic !== topic) {
        return;
    }

    try {
        const message = JSON.parse(uint8ArrayToString(evt.detail.data));
        debugLogger("INFO: Parsed PubSub message: %o", message);
        if (!message || !message.action || !message.shortCode) {
            debugLogger("WARN: Invalid PubSub message structure: %o", message);
            return;
        }

        const { action, shortCode, redirect } = message;
        debugLogger(`INFO: Handling PubSub action: ${action} for ${shortCode}`);

        switch (action) {
            case 'create':
            case 'update':
                if (redirect && redirect.destinationUrl) {
                    const current = redirectsCache.get(shortCode) || {};
                    redirectsCache.set(shortCode, {
                        ...current,
                        ...redirect,
                        shortCode,
                        passwordHash: current.passwordHash || redirect.passwordHash
                    });
                    saveRedirectsCacheToLocalStorage();
                    debugLogger(`INFO: [PubSub] Cached ${action}: ${shortCode}`);
                    if (node?.services?.dht) {
                        const key = `${KEY_PREFIX}${shortCode}`;
                        await node.services.dht.put(
                            uint8ArrayFromString(key),
                            uint8ArrayFromString(JSON.stringify(redirectsCache.get(shortCode))),
                            DHT_PUT_OPTIONS
                        ).catch(err => debugLogger(`ERROR: Failed to save redirect ${shortCode} to DHT: %o`, err));
                    }
                } else {
                    debugLogger(`WARN: [PubSub] Invalid redirect data for ${action}: ${shortCode}`);
                }
                break;
            case 'delete':
                if (redirectsCache.has(shortCode)) {
                    redirectsCache.delete(shortCode);
                    saveRedirectsCacheToLocalStorage();
                    debugLogger(`INFO: [PubSub] Deleted redirect from cache: ${shortCode}`);
                }
                break;
            default:
                debugLogger(`WARN: [PubSub] Unknown action: ${action}`);
        }
    } catch (error) {
        debugLogger(`ERROR: Error handling PubSub message: %o`, error);
    }
}

async function republishActiveRedirects() {
    debugLogger("INFO: Starting republish cycle");
    if (!node || node.status !== 'started') {
        debugLogger("WARN: Node not ready");
        return;
    }
    if (redirectsCache.size === 0) {
        debugLogger("INFO: Republish: No redirects in cache");
        return;
    }
    if (!node.services || !node.services.dht) {
        debugLogger("WARN: DHT not available, skipping republish");
        return;
    }

    debugLogger(`INFO: Republishing ${redirectsCache.size} redirects`);
    let successCount = 0;
    let errorCount = 0;

    for (const [shortCode, redirect] of redirectsCache.entries()) {
        if (shortCode && redirect && redirect.destinationUrl && redirect.passwordHash) {
            const key = `${KEY_PREFIX}${shortCode}`;
            const value = uint8ArrayFromString(JSON.stringify(redirect));
            try {
                await node.services.dht.put(key, value, DHT_PUT_OPTIONS);
                debugLogger(`INFO: Republished redirect: ${shortCode}`);
                successCount++;
            } catch (err) {
                debugLogger(`ERROR: Error republishing redirect ${shortCode}: %o`, err);
                errorCount++;
            }
        } else {
            debugLogger(`WARN: Skipping invalid cache entry: ${shortCode}`);
            redirectsCache.delete(shortCode);
            saveRedirectsCacheToLocalStorage();
        }
    }

    debugLogger(`INFO: Republish cycle finished: ${successCount} successes, ${errorCount} errors`);
}

function startRepublishing() {
    debugLogger("INFO: Starting republishing interval");
    if (republishIntervalId) {
        clearInterval(republishIntervalId);
    }
    republishActiveRedirects();
    republishIntervalId = setInterval(republishActiveRedirects, REPUBLISH_INTERVAL_MS);
}

async function createRedirect(url, description = '') {
    debugLogger("INFO: createRedirect called with: %o", { url, description });
    if (!node || node.status !== 'started') {
        debugLogger("WARN: P2P node not ready, waiting for initialization");
        await startNodePromise.catch(() => {});
    }
    if (!url || typeof url !== 'string' || url.length < 5) {
        debugLogger("ERROR: Invalid URL provided: %s", url);
        throw new Error('Invalid URL provided');
    }

    debugLogger("INFO: Checking network connectivity");
    const connectedPeers = node && node.getPeers ? node.getPeers() : [];
    debugLogger("INFO: Connected peers: %o", connectedPeers.map(p => p.toString()));
    const isIsolated = !node || connectedPeers.length === 0 || !node.services || !node.services.dht;
    if (isIsolated) {
        debugLogger("INFO: Operating in isolated mode");
        updateP2PStatus('No network connection, using local mode');
    }

    let shortCode;
    let attempts = 0;
    let success = false;
    let key;

    updateP2PStatus('Generating unique code...');
    debugLogger("INFO: Starting shortCode generation");
    while (attempts < MAX_SHORTCODE_GENERATION_ATTEMPTS && !success) {
        attempts++;
        shortCode = await generateShortCode(url + Date.now() + Math.random().toString());
        debugLogger(`INFO: Attempt ${attempts} to generate shortCode: ${shortCode}`);
        if (redirectsCache.has(shortCode)) {
            debugLogger(`WARN: Local cache collision for shortCode ${shortCode}`);
            continue;
        }
        key = `${KEY_PREFIX}${shortCode}`;
        if (isIsolated) {
            debugLogger(`INFO: Local mode, skipping DHT check for ${shortCode}`);
            success = true;
            debugLogger(`INFO: Generated unique shortCode ${shortCode} in local mode`);
            continue;
        }
        try {
            debugLogger(`INFO: Querying DHT for key: ${key}`);
            await node.services.dht.get(uint8ArrayFromString(key), { ...DHT_GET_OPTIONS, timeout: 5000 });
            debugLogger(`WARN: DHT collision for shortCode ${shortCode} on attempt ${attempts}`);
        } catch (err) {
            if (err.code === 'ERR_NOT_FOUND' || err.message.includes('not found')) {
                debugLogger(`INFO: DHT confirmed no collision for ${shortCode}`);
                success = true;
                debugLogger(`INFO: Generated unique shortCode ${shortCode} on attempt ${attempts}`);
            } else {
                debugLogger(`ERROR: DHT check error for ${shortCode} on attempt ${attempts}: %o`, err);
                if (attempts >= MAX_SHORTCODE_GENERATION_ATTEMPTS) {
                    debugLogger("WARN: Max attempts reached, assuming shortCode is unique");
                    success = true;
                }
            }
        }
    }

    if (!success) {
        debugLogger("ERROR: Failed to generate unique shortCode after %d attempts", MAX_SHORTCODE_GENERATION_ATTEMPTS);
        throw new Error(`Failed to generate a unique shortCode after ${MAX_SHORTCODE_GENERATION_ATTEMPTS} attempts`);
    }
    updateP2PStatus('Code generated. Creating redirect...');
    debugLogger("INFO: ShortCode generated: %s", shortCode);

    debugLogger("INFO: Generating password");
    const password = generatePassword();
    debugLogger("INFO: Hashing password");
    let passwordHashWithSalt;
    try {
        passwordHashWithSalt = await hashPassword(password);
        debugLogger("INFO: Password hashed successfully");
    } catch (err) {
        debugLogger(`ERROR: Error hashing password: %o`, err);
        throw err;
    }

    const redirect = {
        shortCode,
        destinationUrl: url,
        description: description || '',
        passwordHash: passwordHashWithSalt,
        createdAt: Date.now()
    };
    debugLogger("INFO: Created redirect object: %o", redirect);

    try {
        debugLogger("INFO: Saving redirect to DHT: %s", key);
        if (!isIsolated && node.services && node.services.dht) {
            await node.services.dht.put(
                uint8ArrayFromString(key),
                uint8ArrayFromString(JSON.stringify(redirect)),
                DHT_PUT_OPTIONS
            );
        } else {
            debugLogger(`INFO: Local mode, skipping DHT save for ${shortCode}`);
        }
        updateP2PStatus('Redirect saved to cache');
        redirectsCache.set(shortCode, redirect);
        saveRedirectsCacheToLocalStorage();
    } catch (error) {
        debugLogger(`ERROR: Error saving redirect ${shortCode}: %o`, error);
        updateP2PStatus('Error saving redirect', true);
        throw new Error(`Failed to save redirect: ${error.message}`);
    }

    debugLogger("INFO: Publishing create message for: %s", shortCode);
    const safeRedirect = { destinationUrl: redirect.destinationUrl, description: redirect.description, createdAt: redirect.createdAt };
    const message = { action: 'create', shortCode, redirect: safeRedirect };
    try {
        if (!isIsolated && node.services && node.services.pubsub) {
            await node.services.pubsub.publish(
                topic,
                uint8ArrayFromString(JSON.stringify(message))
            );
            debugLogger(`INFO: Published create message for ${shortCode}`);
            updateP2PStatus('Published creation message');
        } else {
            debugLogger(`INFO: Local mode, skipping PubSub publish for ${shortCode}`);
            updateP2PStatus('Skipped network publish in local mode');
        }
    } catch (error) {
        debugLogger(`ERROR: Error publishing create message for ${shortCode}: %o`, error);
        updateP2PStatus('Error publishing creation message', true);
    }

    debugLogger("INFO: Caching redirect locally: %s", shortCode);
    redirectsCache.set(shortCode, redirect);
    saveRedirectsCacheToLocalStorage();

    updateP2PStatus('Redirect created successfully');
    debugLogger("INFO: createRedirect completed with: %o", { shortCode, password });
    return { shortCode, password };
}

async function getRedirect(shortCode) {
    debugLogger("INFO: getRedirect called with: %s", shortCode);
    if (!shortCode) {
        debugLogger("WARN: getRedirect: Empty shortCode provided");
        return null;
    }
    await startNodePromise.catch(err => {
        debugLogger('WARN: Node failed to start, proceeding in local mode: %o', err);
    });

    if (redirectsCache.has(shortCode)) {
        debugLogger(`INFO: getRedirect: Found ${shortCode} in cache`);
        updateP2PStatus(`Redirect ${shortCode} found in cache`);
        return redirectsCache.get(shortCode);
    }

    if (!node || node.status !== 'started' || !node.services || !node.services.dht) {
        debugLogger(`WARN: getRedirect: Node not ready or DHT disabled, returning null for ${shortCode}`);
        updateP2PStatus(`No network connection, ${shortCode} not found`, true);
        return null;
    }

    debugLogger(`INFO: getRedirect: Querying DHT for ${shortCode}`);
    updateP2PStatus(`Querying network for ${shortCode}...`);
    const key = `${KEY_PREFIX}${shortCode}`;
    try {
        const recordBytes = await node.services.dht.get(uint8ArrayFromString(key), DHT_GET_OPTIONS);
        if (recordBytes) {
            const redirect = JSON.parse(uint8ArrayToString(recordBytes));
            if (redirect && redirect.destinationUrl && redirect.passwordHash && redirect.shortCode === shortCode) {
                debugLogger(`INFO: Found redirect ${shortCode} in DHT`);
                updateP2PStatus(`Redirect ${shortCode} found in network`);
                redirectsCache.set(shortCode, redirect);
                saveRedirectsCacheToLocalStorage();
                return redirect;
            } else {
                debugLogger(`WARN: getRedirect: Invalid redirect data from DHT for ${shortCode}: %o`, redirect);
                updateP2PStatus(`Invalid data received for ${shortCode}`, true);
                return null;
            }
        } else {
            debugLogger(`WARN: getRedirect: DHT returned empty for ${shortCode}`);
            updateP2PStatus(`Network query for ${shortCode} returned empty`, true);
            return null;
        }
    } catch (err) {
        if (err.code === 'ERR_NOT_FOUND' || err.message.includes('not found')) {
            debugLogger(`INFO: getRedirect: ${shortCode} not found in DHT`);
            updateP2PStatus(`Redirect ${shortCode} not found`);
        } else {
            debugLogger(`ERROR: getRedirect: Error querying DHT for ${shortCode}: %o`, err);
            updateP2PStatus(`Error querying network for ${shortCode}`, true);
        }
        return null;
    }
}

async function updateRedirect(shortCode, newUrl, newDescription, redirectPassword) {
    debugLogger("INFO: updateRedirect called with: %o", { shortCode, newUrl, newDescription });
    await startNodePromise.catch(err => {
        debugLogger('WARN: Node failed to start, proceeding in local mode: %o', err);
    });

    if (!node || node.status !== 'started') {
        debugLogger("WARN: updateRedirect: P2P node not ready, using local mode");
        updateP2PStatus('P2P node not ready, using local mode', true);
    }
    if (!newUrl || typeof newUrl !== 'string' || newUrl.length < 5) {
        debugLogger("ERROR: updateRedirect: Invalid new URL: %s", newUrl);
        throw new Error('Invalid new URL provided');
    }

    updateP2PStatus(`Attempting to update ${shortCode}...`);
    debugLogger(`INFO: Fetching redirect ${shortCode} for update`);
    const stored = await getRedirect(shortCode);
    if (!stored) {
        debugLogger(`ERROR: updateRedirect: Redirect ${shortCode} not found`);
        updateP2PStatus(`Update failed: Redirect ${shortCode} not found`, true);
        throw new Error('Redirect not found');
    }

    debugLogger("INFO: Verifying password for: %s", shortCode);
    const isValidPassword = await verifyRedirectPassword(redirectPassword, stored.passwordHash);
    if (!isValidPassword) {
        debugLogger(`ERROR: updateRedirect: Incorrect password for ${shortCode}`);
        updateP2PStatus(`Update failed: Incorrect password for ${shortCode}`, true);
        throw new Error('Incorrect redirect password');
    }
    updateP2PStatus('Password verified. Saving update...');
    debugLogger("INFO: Password verified successfully");

    const isIsolated = !node || !node.getPeers || node.getPeers().length === 0 || !node.services || !node.services.dht;
    const updatedRedirect = {
        ...stored,
        destinationUrl: newUrl,
        description: newDescription !== undefined ? newDescription : stored.description,
        updatedAt: Date.now()
    };
    debugLogger("INFO: Created updated redirect object: %o", updatedRedirect);

    const key = `${KEY_PREFIX}${shortCode}`;
    try {
        debugLogger("INFO: Saving updated redirect to DHT: %s", key);
        if (!isIsolated && node.services && node.services.dht) {
            await node.services.dht.put(
                uint8ArrayFromString(key),
                uint8ArrayFromString(JSON.stringify(updatedRedirect)),
                DHT_PUT_OPTIONS
            );
        } else {
            debugLogger(`INFO: Local mode, skipping DHT update for ${shortCode}`);
        }
        updateP2PStatus('Update saved to cache');
        redirectsCache.set(shortCode, updatedRedirect);
        saveRedirectsCacheToLocalStorage();
    } catch (error) {
        debugLogger(`ERROR: Error updating redirect ${shortCode}: %o`, error);
        updateP2PStatus('Error saving update', true);
        throw new Error(`Failed to update redirect: ${error.message}`);
    }

    debugLogger("INFO: Publishing update message for: %s", shortCode);
    const safeRedirect = { destinationUrl: updatedRedirect.destinationUrl, description: updatedRedirect.description, updatedAt: updatedRedirect.updatedAt };
    const message = { action: 'update', shortCode, redirect: safeRedirect };
    try {
        if (!isIsolated && node.services && node.services.pubsub) {
            await node.services.pubsub.publish(
                topic,
                uint8ArrayFromString(JSON.stringify(message))
            );
            debugLogger(`INFO: Published update message for ${shortCode}`);
            updateP2PStatus('Published update message');
        } else {
            debugLogger(`INFO: Local mode, skipping PubSub update for ${shortCode}`);
            updateP2PStatus('Skipped network update in local mode');
        }
    } catch (error) {
        debugLogger(`ERROR: Error publishing update message for ${shortCode}: %o`, error);
        updateP2PStatus('Error publishing update message', true);
    }

    debugLogger("INFO: Updating local cache for: %s", shortCode);
    redirectsCache.set(shortCode, updatedRedirect);
    saveRedirectsCacheToLocalStorage();
    debugLogger(`INFO: Redirect ${shortCode} updated in local cache`);

    updateP2PStatus(`Redirect ${shortCode} updated successfully`);
    debugLogger("INFO: updateRedirect completed");
    return { success: true };
}

async function deleteRedirect(shortCode, redirectPassword) {
    debugLogger("INFO: deleteRedirect called with: %o", { shortCode });
    await startNodePromise.catch(err => {
        debugLogger('WARN: Node failed to start, proceeding in local mode: %o', err);
    });

    if (!node || node.status !== 'started') {
        debugLogger("WARN: deleteRedirect: P2P node not ready, using local mode");
        updateP2PStatus('P2P node not ready, using local mode', true);
    }

    updateP2PStatus(`Attempting to delete ${shortCode}...`);
    debugLogger(`INFO: Fetching redirect ${shortCode} for deletion`);
    const stored = redirectsCache.get(shortCode) || await getRedirect(shortCode);
    if (!stored) {
        debugLogger(`WARN: deleteRedirect: Redirect ${shortCode} not found`);
        updateP2PStatus(`Deletion skipped: Redirect ${shortCode} not found`);
        return { success: true, message: 'Redirect not found' };
    }

    debugLogger("INFO: Verifying password for deletion: %s", shortCode);
    const isValidPassword = await verifyRedirectPassword(redirectPassword, stored.passwordHash);
    if (!isValidPassword) {
        debugLogger(`ERROR: deleteRedirect: Incorrect password for ${shortCode}`);
        updateP2PStatus(`Deletion failed: Incorrect password for ${shortCode}`, true);
        throw new Error('Incorrect redirect password');
    }
    updateP2PStatus('Password verified. Deleting...');
    debugLogger("INFO: Password verified for deletion");

    const isIsolated = !node || !node.getPeers || node.getPeers().length === 0 || !node.services || !node.services.dht;
    debugLogger("INFO: Publishing delete message for: %s", shortCode);
    const message = { action: 'delete', shortCode };
    try {
        if (!isIsolated && node.services && node.services.pubsub) {
            await node.services.pubsub.publish(
                topic,
                uint8ArrayFromString(JSON.stringify(message))
            );
            debugLogger(`INFO: Published delete message for ${shortCode}`);
            updateP2PStatus('Published deletion message');
        } else {
            debugLogger(`INFO: Local mode, skipping PubSub delete for ${shortCode}`);
            updateP2PStatus('Skipped network delete in local mode');
        }
    } catch (error) {
        debugLogger(`ERROR: Error publishing delete message for ${shortCode}: %o`, error);
        updateP2PStatus('Error publishing deletion message', true);
    }

    const deletedFromCache = redirectsCache.delete(shortCode);
    if (deletedFromCache) {
        debugLogger(`INFO: Redirect ${shortCode} deleted from local cache`);
        updateP2PStatus('Removed from local cache');
        saveRedirectsCacheToLocalStorage();
    } else {
        debugLogger(`WARN: Redirect ${shortCode} was not in cache`);
    }

    updateP2PStatus(`Redirect ${shortCode} deleted successfully`);
    debugLogger("INFO: deleteRedirect completed");
    return { success: true };
}

function getLocalRedirects(searchQuery = '') {
    debugLogger("INFO: getLocalRedirects called with query: %s", searchQuery);
    const query = searchQuery.toLowerCase().trim();
    const allCached = Array.from(redirectsCache.values());
    debugLogger("INFO: Cached redirects: %o", allCached);

    if (!query) {
        return allCached;
    }

    const filtered = allCached.filter(r =>
        (r.shortCode && r.shortCode.toLowerCase().includes(query)) ||
        (r.description && r.description.toLowerCase().includes(query)) ||
        (r.destinationUrl && r.destinationUrl.toLowerCase().includes(query))
    );
    debugLogger("INFO: Filtered redirects: %o", filtered);
    return filtered;
}

function generatePassword(length = 12) {
    debugLogger("INFO: generatePassword called with length: %d", length);
    const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let password = "";
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        const values = new Uint32Array(length);
        crypto.getRandomValues(values);
        for (let i = 0; i < length; i++) {
            password += charset[values[i] % charset.length];
        }
        debugLogger("INFO: Generated password using crypto");
    } else {
        debugLogger("WARN: Using Math.random for password generation");
        for (let i = 0; i < length; i++) {
            password += charset.charAt(Math.floor(Math.random() * charset.length));
        }
    }
    debugLogger("INFO: Generated password: %s", password);
    return password;
}

function generateSalt(length = 16) {
    debugLogger("INFO: generateSalt called with length: %d", length);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        const values = new Uint8Array(length);
        crypto.getRandomValues(values);
        const salt = Array.from(values, byte => byte.toString(16).padStart(2, '0')).join('');
        debugLogger("INFO: Generated salt using crypto: %s", salt);
        return salt;
    } else {
        debugLogger("WARN: Using Math.random for salt generation");
        let salt = '';
        for (let i = 0; i < length * 2; i++) {
            salt += Math.floor(Math.random() * 16).toString(16);
        }
        debugLogger("INFO: Generated salt using Math.random: %s", salt);
        return salt;
    }
}

async function hashPassword(password, salt = null) {
    debugLogger("INFO: hashPassword called with: %o", { password, salt });
    const currentSalt = salt || generateSalt();
    if (isCryptoAvailable) {
        debugLogger("INFO: Using Web Crypto API for hashing");
        try {
            const encoder = new TextEncoder();
            const data = encoder.encode(password + currentSalt);
            debugLogger("INFO: Text encoded successfully");
            const hashBuffer = await crypto.subtle.digest('SHA-256', data);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
            const result = `${currentSalt}:${hashHex}`;
            debugLogger("INFO: Password hashed: %s", result);
            return result;
        } catch (err) {
            debugLogger(`ERROR: Error in hashPassword with Web Crypto: %o`, err);
            throw err;
        }
    } else {
        debugLogger("WARN: Web Crypto API unavailable, using crypto-browserify");
        const hash = createHash('sha256');
        hash.update(password + currentSalt);
        const hashHex = hash.digest('hex');
        const result = `${currentSalt}:${hashHex}`;
        debugLogger("INFO: Password hashed with crypto-browserify: %s", result);
        return result;
    }
}

async function verifyRedirectPassword(providedPassword, storedSaltAndHash) {
    debugLogger("INFO: verifyRedirectPassword called with: %o", { providedPassword, storedSaltAndHash });
    if (!providedPassword || !storedSaltAndHash || !storedSaltAndHash.includes(':')) {
        debugLogger("WARN: Invalid input or hash format for password verification");
        return false;
    }
    const [salt, storedHash] = storedSaltAndHash.split(':');
    if (!salt || !storedHash) {
        debugLogger("WARN: Could not parse salt and hash");
        return false;
    }

    try {
        debugLogger("INFO: Hashing provided password for verification");
        const providedHashWithStoredSalt = await hashPassword(providedPassword, salt);
        const isValid = providedHashWithStoredSalt === storedSaltAndHash;
        debugLogger("INFO: Password verification result: %o", isValid);
        return isValid;
    } catch (error) {
        debugLogger(`ERROR: Error during password verification: %o`, error);
        return false;
    }
}

async function generateShortCode(inputString) {
    debugLogger("INFO: generateShortCode called with: %s", inputString);
    if (isCryptoAvailable) {
        debugLogger("INFO: Using Web Crypto API for shortCode generation");
        try {
            const encoder = new TextEncoder();
            const data = encoder.encode(inputString);
            debugLogger("INFO: Text encoded successfully for shortCode");
            const hashBuffer = await crypto.subtle.digest('SHA-256', data);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
            const shortCode = hashHex.slice(0, 10);
            debugLogger("INFO: Generated shortCode: %s", shortCode);
            return shortCode;
        } catch (err) {
            debugLogger(`ERROR: Error in generateShortCode with Web Crypto: %o`, err);
            throw err;
        }
    } else {
        debugLogger("WARN: Web Crypto API unavailable, using crypto-browserify");
        const hash = createHash('sha256');
        hash.update(inputString);
        const hashHex = hash.digest('hex');
        const shortCode = hashHex.slice(0, 10);
        debugLogger("INFO: Generated shortCode with crypto-browserify: %s", shortCode);
        return shortCode;
    }
}

// Дебаг експорту
console.log('DEBUG: Exporting from p2p.js:', {
    startNodePromise: !!startNodePromise,
    stopNode: typeof stopNode,
    createRedirect: typeof createRedirect,
    getRedirect: typeof getRedirect,
    updateRedirect: typeof updateRedirect,
    deleteRedirect: typeof deleteRedirect,
    getLocalRedirects: typeof getLocalRedirects,
    verifyRedirectPassword: typeof verifyRedirectPassword
});

export {
    startNodePromise,
    stopNode,
    createRedirect,
    getRedirect,
    updateRedirect,
    deleteRedirect,
    getLocalRedirects,
    verifyRedirectPassword
};