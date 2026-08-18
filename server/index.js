const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const logger = require('./services/logger');
const connectHost = require('./services/connectHost');
const serverManager = require('./services/serverManager');
const autoUpdateScheduler = require('./services/autoUpdateScheduler');
const gitCatalogScheduler = require('./services/gitCatalogScheduler');

// Routes
const serverRoutes = require('./routes/servers');
const modRoutes = require('./routes/mods');
const playerRoutes = require('./routes/players');
const portRoutes = require('./routes/ports');
const apiRoutes = require('./routes/api');
const bedrockConnectRoutes = require('./routes/bedrockConnect');
const dnsProxy = require('./services/dnsProxy');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
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

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Static files
app.use(express.static(path.join(__dirname, '../public')));

// ========== API ROUTES ==========

app.use('/api/servers', serverRoutes);
app.use('/api/mods', modRoutes);
app.use('/api/players', playerRoutes);
app.use('/api/ports', portRoutes);
app.use('/api/bedrock-connect', bedrockConnectRoutes);
app.use('/api/v1', apiRoutes); // Public API

// Health endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    hostname: connectHost.managerHostname(),
    lanIp: connectHost.detectLanIPv4() || null,
  });
});

// Let client-side routes such as /servers/:id load directly or after refresh.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  if (path.extname(req.path)) return next();
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ========== WEBSOCKET HANDLERS ==========

io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id}`);

  // Join server-specific room
  socket.on('join-server', (serverId) => {
    socket.join(`server-${serverId}`);
    logger.info(`Client ${socket.id} joined server-${serverId}`);
  });

  socket.on('leave-server', (serverId) => {
    socket.leave(`server-${serverId}`);
  });

  // Send command to server
  socket.on('send-command', async ({ serverId, command }) => {
    try {
      await serverManager.sendCommand(serverId, command);
      socket.emit('command-sent', { success: true, command });
    } catch (err) {
      socket.emit('command-error', { error: err.message });
    }
  });

  // Start server
  socket.on('start-server', async (serverId) => {
    try {
      await serverManager.startServer(serverId);
      io.emit('server-status', { serverId, status: 'starting' });
    } catch (err) {
      socket.emit('server-error', { serverId, error: err.message });
    }
  });

  // Stop server
  socket.on('stop-server', async (serverId) => {
    try {
      await serverManager.stopServer(serverId);
      io.emit('server-status', { serverId, status: 'stopped' });
    } catch (err) {
      socket.emit('server-error', { serverId, error: err.message });
    }
  });

  // Server output listener - relay PTY output to connected clients
  const ptyOutputListener = async () => {
    const servers = serverManager.getAllServers();
    for (const srv of servers) {
      if (srv.status === 'running') {
        const pty = serverManager.ptySessions.get(String(srv.id));
        if (pty) {
          // Read any available output (non-blocking)
          // This is handled by the PTY data event below
        }
      }
    }
  };

  // Listen for server output
  const checkServers = setInterval(ptyOutputListener, 5000);

  // Disconnect
  socket.on('disconnect', () => {
    logger.info(`Client disconnected: ${socket.id}`);
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
            data
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
});

// Graceful shutdown
const gracefulShutdown = (signal) => {
  logger.info(`${signal} received, shutting down...`);
  autoUpdateScheduler.stop();
  gitCatalogScheduler.stop();
  dnsProxy.stop().catch(() => {});
  serverManager.shutdown();
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
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
