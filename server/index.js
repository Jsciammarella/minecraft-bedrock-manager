const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { version: managerVersion } = require('../package.json');
const logger = require('./services/logger');
const connectHost = require('./services/connectHost');
const serverManager = require('./services/serverManager');
const playerPresence = require('./services/playerPresence');
const autoUpdateScheduler = require('./services/autoUpdateScheduler');
const gitCatalogScheduler = require('./services/gitCatalogScheduler');

// Routes
const serverRoutes = require('./routes/servers');
const modRoutes = require('./routes/mods');
const playerRoutes = require('./routes/players');
const portRoutes = require('./routes/ports');
const apiRoutes = require('./routes/api');
const bedrockConnectRoutes = require('./routes/bedrockConnect');
const pluginHost = require('./services/pluginHost');
const pluginRoutes = require('./routes/plugins');
const dnsProxy = require('./services/dnsProxy');
const authRoutes = require('./routes/auth');
const security = require('./security');
const { attachPrincipal, isPublicApiPath } = require('./security/middleware');
const pluginActions = require('./services/pluginActions');
const pluginSettings = require('./services/pluginSettings');
const socketAuth = require('./security/socketAuth');

try {
  security.ensureReady();
} catch (err) {
  logger.error(err.message);
  process.exit(1);
}

pluginActions.setPermissionResolver((permission, context = {}) => {
  if (!permission) return false;
  const current = context.user || context.principal;
  return security.authorize(current, permission, context.resource, context);
});

pluginSettings.setPermissionResolver((permission, context = {}) => {
  if (!permission) return false;
  const current = context.user || context.principal;
  return security.authorize(current, permission, context.resource, context);
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true,
    methods: ['GET', 'POST']
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Make io globally available for services
global.io = io;

const PORT = process.env.PORT || 3000;

// ========== MIDDLEWARE ==========

// Security headers (relaxed for dev)
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Static files
app.use(express.static(path.join(__dirname, '../public')));

app.use((req, res, next) => {
  if (!req.path.startsWith('/api')) return next();
  if (isPublicApiPath(req)) return next();
  return attachPrincipal(req, res, next);
});

// ========== API ROUTES ==========

app.use('/api/auth', authRoutes);
if (security.supports('userManagement')) {
  app.use('/api/user-management', require('./routes/userManagement'));
} else {
  app.use('/api/user-management', (_req, res) => {
    res.status(404).json({ error: 'User management is not available' });
  });
}
app.use('/api/servers', serverRoutes);
app.use('/api/mods', modRoutes);
app.use('/api/players', playerRoutes);
app.use('/api/ports', portRoutes);
app.use('/api/bedrock-connect', bedrockConnectRoutes);
app.use('/api/v1', apiRoutes);
pluginHost.loadPlugins();
security.syncDynamicPermissions();
app.use('/api/plugins', pluginRoutes);
app.use('/api/java', require('./routes/java'));
app.use('/api/gateways', require('./routes/gateways'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/plugin-actions', require('./routes/pluginActions'));
app.get('/api/editions', (req, res) => {
  try {
    res.json({ editions: require('./services/javaHostingPolicy').listEditions() });
  } catch (err) {
    res.status(500).json({ error: err.message, editions: [{ id: 'bedrock', label: 'Bedrock', available: true, core: true }] });
  }
});
app.get('/api/gateway-providers', (req, res) => {
  res.json({ providers: require('./services/gatewayRegistry').list() });
});
logger.info(`Loaded ${pluginHost.getMenuItems().length} plugin menu item(s)`);

app.get('/api/system', (_req, res) => {
  const identity = require('./services/productIdentity');
  res.json({
    ...security.publicInfo(),
    version: managerVersion,
    hostname: connectHost.managerHostname(),
    product: identity.PRODUCT_NAME,
  });
});

// Health endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    hostname: connectHost.managerHostname(),
    lanIp: connectHost.detectLanIPv4() || null,
    version: managerVersion,
    securityProfile: security.publicInfo().securityProfile,
    authenticationRequired: security.publicInfo().authenticationRequired,
  });
});

// Let client-side routes such as /servers/:id load directly or after refresh.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  if (path.extname(req.path)) return next();
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ========== WEBSOCKET HANDLERS ==========

socketAuth.attach(io);

io.on('connection', (socket) => {
  const ptyOutputListener = async () => {
    const servers = serverManager.getAllServers();
    for (const srv of servers) {
      if (srv.status === 'running') {
        serverManager.ptySessions.get(String(srv.id));
      }
    }
  };
  const checkServers = setInterval(ptyOutputListener, 5000);
  socket.on('disconnect', () => {
    clearInterval(checkServers);
  });
});

// PTY output broadcasting
const setupPtyListeners = () => {
  const servers = serverManager.getAllServers();
  for (const srv of servers) {
    if (srv.status === 'running') {
      const pty = serverManager.ptySessions.get(String(srv.id));
      if (pty) {
        pty.on('data', (data) => {
          io.to(`server-${srv.id}`).emit('server-output', {
            serverId: srv.id,
            data: playerPresence.stripAnsi(data)
          });
        });
      }
    }
  }
};

// ========== START SERVER ==========

server.listen(PORT, '0.0.0.0', () => {
  logger.info(`Minecraft Bedrock Manager started on port ${PORT}`);
  logger.info(`API available at http://localhost:${PORT}/api`);
  logger.info(`Public API at http://localhost:${PORT}/api/v1`);
  logger.info(`Security profile: ${security.publicInfo().securityProfile}`);

  // Setup PTY listeners for already-running servers
  setupPtyListeners();

  // Start auto-update scheduler
  autoUpdateScheduler.start();
  gitCatalogScheduler.start();

  try {
    require('./services/lanBroadcast').reapOrphans();
  } catch (err) {
    logger.warn(`Could not reap leftover LAN proxies: ${err.message}`);
  }
  serverManager.relocateRemotesOffDiscoveryPorts()
    .catch((err) => {
      logger.warn(`Could not move remotes off LAN discovery ports: ${err.message}`);
    })
    .then(() => serverManager.restoreLanBroadcasts())
    .catch((err) => {
      logger.warn(`LAN broadcast restore failed: ${err.message}`);
    });
  dnsProxy.sync().catch((err) => {
    logger.warn(`DNS proxy restore failed: ${err.message}`);
  });
  require('./services/javaHostingPolicy').reconcileOnStartup().catch((err) => {
    logger.warn(`Java hosting reconcile failed: ${err.message}`);
  });
  require('./services/gatewayManager').restoreRunning().catch((err) => {
    logger.warn(`Gateway restore failed: ${err.message}`);
  });
  require('./services/bedrockConnectLifecycle').reconcileOnStartup().catch((err) => {
    logger.warn(`Bedrock Connect startup reconcile failed: ${err.message}`);
  });
});

// Graceful shutdown
const gracefulShutdown = (signal) => {
  logger.info(`${signal} received, shutting down...`);
  autoUpdateScheduler.stop();
  gitCatalogScheduler.stop();
  dnsProxy.stop().catch(() => {});
  Promise.resolve(serverManager.shutdown()).finally(() => {
    server.close(() => {
      logger.info('Server closed');
      process.exit(0);
    });
  });
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Error handling
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
  process.exit(1);
});

module.exports = { app, server, io };
