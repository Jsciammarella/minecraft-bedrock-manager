const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const db = require('../db/connection');
const logger = require('./logger');
const settingsStore = require('./settingsStore');
const execAsync = promisify(exec);

const BASE_DIR = path.join(__dirname, '../../data/servers');
const MODS_DIR = path.join(__dirname, '../../data/mods');
const BEDROCK_CONNECT_PORT = 19132;

class ServerManager {
  constructor() {
    this.servers = new Map(); // in-memory server state
    this.ptySessions = new Map(); // serverId -> pty session
    this.processes = new Map(); // serverId -> process reference
    this.scheduledRestarts = new Map(); // serverId -> warning/restart timers
    this.provisionJobs = new Map();

    // Ensure directories exist
    fs.mkdirSync(BASE_DIR, { recursive: true });
    fs.mkdirSync(MODS_DIR, { recursive: true });

    // A managed Bedrock process cannot survive a manager/container restart because
    // its PTY belongs to this process. Never carry an old "running" state forward.
    const reconciled = db.prepare(`
      UPDATE servers
      SET status = 'stopped', pid = NULL, started_at = NULL, restart_scheduled_at = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE status IN ('running', 'starting', 'creating')
    `).run();
    if (reconciled.changes > 0) {
      logger.warn(`Reset ${reconciled.changes} stale server status record(s) during manager startup`);
    }
  }

  sessionKey(serverId) {
    return String(serverId);
  }

  invalidateServerCache(serverId) {
    this.servers.delete(this.sessionKey(serverId));
  }

  markServerStopped(serverId, { broadcast = true } = {}) {
    const server = this.getServer(serverId);
    this.cancelWarnedRestart(serverId, { broadcast: false });
    db.prepare(`
      UPDATE servers
      SET status = 'stopped', pid = NULL, started_at = NULL, restart_scheduled_at = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(serverId);
    this.invalidateServerCache(serverId);
    if (broadcast) this.broadcastServerStatus(serverId);
    if (this.isBedrockConnect(server)) {
      this.restoreLanBroadcasts().catch((err) => {
        logger.warn(`LAN broadcast restore after Bedrock Connect stop failed: ${err.message}`);
      });
    }
  }

  markRestartRequired(serverId, reason) {
    const current = db.prepare(`
      SELECT pending_restart_reason FROM servers WHERE id = ?
    `).get(serverId);
    if (!current) throw new Error('Server not found');

    const reasons = String(current.pending_restart_reason || '')
      .split(';')
      .map(value => value.trim())
      .filter(Boolean);
    if (reason && !reasons.includes(reason)) reasons.push(reason);

    db.prepare(`
      UPDATE servers
      SET pending_restart = 1, pending_restart_reason = ?,
        pending_restart_at = COALESCE(pending_restart_at, CURRENT_TIMESTAMP),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(reasons.join('; '), serverId);
    this.invalidateServerCache(serverId);
    this.broadcastServerStatus(serverId);
  }

  cancelWarnedRestart(serverId, { broadcast = true, clearPendingBedrockConnect = false } = {}) {
    const key = this.sessionKey(serverId);
    const scheduled = this.scheduledRestarts.get(key);
    if (scheduled) {
      scheduled.timers.forEach(timer => clearTimeout(timer));
      this.scheduledRestarts.delete(key);
    }
    db.prepare('UPDATE servers SET restart_scheduled_at = NULL WHERE id = ?').run(serverId);
    this.invalidateServerCache(serverId);
    if (clearPendingBedrockConnect) {
      const pending = this.getPendingBedrockConnect();
      if (pending && Number(pending.occupantId) === Number(serverId)) {
        this.setPendingBedrockConnect(null);
        if (pending.nextPort) {
          db.prepare(`
            UPDATE servers
            SET pending_port = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND pending_port = ?
          `).run(serverId, pending.nextPort);
          this.invalidateServerCache(serverId);
        }
      }
      const pendingLan = this.getPendingLanBroadcast();
      if (pendingLan && Number(pendingLan.occupantId) === Number(serverId)) {
        this.setPendingLanBroadcast(null);
        if (pendingLan.nextPort) {
          db.prepare(`
            UPDATE servers
            SET pending_port = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND pending_port = ?
          `).run(serverId, pendingLan.nextPort);
          this.invalidateServerCache(serverId);
        }
        const requesterIds = (pendingLan.enableIds || [])
          .filter(id => Number(id) !== Number(pendingLan.occupantId));
        for (const id of requesterIds) {
          db.prepare('UPDATE servers SET lan_broadcast = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
          this.invalidateServerCache(id);
        }
      }
    }
    if (broadcast) this.broadcastServerStatus(serverId);
    return { success: true };
  }

  isBedrockConnect(server) {
    return Boolean(server && server.kind === 'bedrock_connect');
  }

  getBedrockConnectServer() {
    return db.prepare("SELECT * FROM servers WHERE kind = 'bedrock_connect' LIMIT 1").get();
  }

  isBedrockConnectActive() {
    const bc = this.getBedrockConnectServer();
    return Boolean(bc && (bc.status === 'running' || bc.status === 'starting'));
  }

  getPendingBedrockConnect() {
    try {
      const raw = settingsStore.get(settingsStore.KEYS.BEDROCK_CONNECT_PENDING);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  setPendingBedrockConnect(value) {
    if (!value) settingsStore.remove(settingsStore.KEYS.BEDROCK_CONNECT_PENDING);
    else settingsStore.set(settingsStore.KEYS.BEDROCK_CONNECT_PENDING, JSON.stringify(value));
  }

  getPendingLanBroadcast() {
    try {
      const raw = settingsStore.get(settingsStore.KEYS.LAN_BROADCAST_PENDING);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  setPendingLanBroadcast(value) {
    if (!value) settingsStore.remove(settingsStore.KEYS.LAN_BROADCAST_PENDING);
    else settingsStore.set(settingsStore.KEYS.LAN_BROADCAST_PENDING, JSON.stringify(value));
  }

  attachLanStatus(server) {
    if (!server) return server;
    const lanBroadcast = require('./lanBroadcast');
    const lan = lanBroadcast.statusFor(server);
    if (this.isBedrockConnect(server)) {
      return {
        ...server,
        lan: { ...lan, enabled: false, active: false, native: false, error: null },
      };
    }
    if (this.isBedrockConnectActive() && lan.enabled && !lan.native && !lan.active) {
      return {
        ...server,
        lan: {
          ...lan,
          error: lan.error || 'Bedrock Connect is running on UDP 19132. Stop or remove Bedrock Connect to start LAN proxy.',
        },
      };
    }
    return { ...server, lan };
  }

  stopLanBroadcastsForBedrockConnect() {
    require('./lanBroadcast').stopAll();
  }

  async previewLanBroadcast(serverId) {
    const lanBroadcast = require('./lanBroadcast');
    const server = this.getServer(serverId);
    if (!server) throw new Error('Server not found');
    if (this.isBedrockConnect(server)) {
      return {
        allowed: false,
        reason: 'bedrock_connect',
        message: 'Bedrock Connect is a featured-server list, not a LAN game. Nintendo Switch still needs it.',
        lan: lanBroadcast.statusFor(server),
      };
    }
    if (Number(server.port) === lanBroadcast.DISCOVERY_PORT) {
      return {
        allowed: true,
        native: true,
        conflict: null,
        message: 'This server already uses UDP 19132, so consoles on the same LAN can see it without a proxy.',
        lan: lanBroadcast.statusFor({ ...server, lan_broadcast: 1 }),
      };
    }
    if (this.isBedrockConnectActive()) {
      return {
        allowed: false,
        reason: 'bedrock_connect_occupies',
        message: 'Bedrock Connect is running on UDP 19132. Stop or remove Bedrock Connect to start LAN proxy.',
        lan: lanBroadcast.statusFor(server),
      };
    }
    if (lanBroadcast.isActive(serverId) || [...this.getAllServers()].some(item => lanBroadcast.isActive(item.id))) {
      return { allowed: true, native: false, conflict: null, lan: lanBroadcast.statusFor(server) };
    }
    const occupant = db.prepare('SELECT * FROM servers WHERE port = ? AND id != ?').get(lanBroadcast.DISCOVERY_PORT, serverId);
    if (occupant && !this.isBedrockConnect(occupant)) {
      const nextPort = await this.nextAvailablePort({
        exclude: [lanBroadcast.DISCOVERY_PORT, occupant.port, server.port],
      });
      return {
        allowed: true,
        native: false,
        conflict: {
          serverId: occupant.id,
          serverName: occupant.name,
          status: occupant.status,
          currentPort: occupant.port,
          nextPort,
        },
        message: `${occupant.name} is using UDP 19132. Consoles look for LAN games on that port, so it must be moved before LAN listing can start.`,
        lan: lanBroadcast.statusFor(server),
      };
    }
    const free = await this.isUdpPortAvailable(lanBroadcast.DISCOVERY_PORT);
    if (!free) {
      return {
        allowed: false,
        reason: 'port_blocked',
        message: 'UDP 19132 is in use by another process. Free it before enabling LAN listing.',
        lan: lanBroadcast.statusFor(server),
      };
    }
    return { allowed: true, native: false, conflict: null, lan: lanBroadcast.statusFor(server) };
  }

  async setLanBroadcast(serverId, enabled, { acceptConflict = false, restartMode = 'immediate' } = {}) {
    const lanBroadcast = require('./lanBroadcast');
    const server = this.getServer(serverId);
    if (!server) throw new Error('Server not found');
    if (this.isBedrockConnect(server)) {
      throw new Error('Bedrock Connect cannot be advertised as a LAN game');
    }
    if (server.status === 'creating') {
      throw new Error('Wait until this server finishes building before enabling LAN listing');
    }

    if (!enabled) {
      lanBroadcast.stop(serverId);
      db.prepare('UPDATE servers SET lan_broadcast = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(serverId);
      this.invalidateServerCache(serverId);
      this.broadcastServerStatus(serverId);
      return { success: true, enabled: false, lan: lanBroadcast.statusFor(this.getServer(serverId)) };
    }

    const preview = await this.previewLanBroadcast(serverId);
    if (!preview.allowed) {
      const err = new Error(preview.message);
      err.code = preview.reason === 'bedrock_connect_occupies' ? 'BC_CONFLICT' : 'LAN_BLOCKED';
      throw err;
    }

    if (preview.conflict && !acceptConflict) {
      const err = new Error(preview.message);
      err.code = 'PORT_CONFLICT';
      err.conflict = preview.conflict;
      throw err;
    }

    if (preview.conflict) {
      const occupant = this.getServer(preview.conflict.serverId);
      if (occupant.status === 'running' && restartMode === 'warned') {
        await this.queuePortChange(occupant.id, preview.conflict.nextPort, { restartRequired: true });
        this.scheduleWarnedRestart(occupant.id);
        this.setPendingLanBroadcast({
          occupantId: occupant.id,
          nextPort: preview.conflict.nextPort,
          enableIds: [Number(serverId), Number(occupant.id)],
          createdAt: new Date().toISOString(),
        });
        db.prepare('UPDATE servers SET lan_broadcast = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(serverId);
        this.invalidateServerCache(serverId);
        return {
          pending: true,
          conflict: preview.conflict,
          message: `${occupant.name} will move to port ${preview.conflict.nextPort} after the five-minute restart. LAN listing starts then.`,
        };
      }
      await this.relocateServerForBedrockConnect(occupant.id, preview.conflict.nextPort);
      db.prepare('UPDATE servers SET lan_broadcast = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(occupant.id);
      this.invalidateServerCache(occupant.id);
    }

    db.prepare('UPDATE servers SET lan_broadcast = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(serverId);
    this.invalidateServerCache(serverId);

    if (preview.native) {
      this.broadcastServerStatus(serverId);
      return { success: true, enabled: true, native: true, lan: lanBroadcast.statusFor(this.getServer(serverId)) };
    }

    await this.syncLanBroadcast(serverId);
    if (preview.conflict) await this.syncLanBroadcast(preview.conflict.serverId);
    this.broadcastServerStatus(serverId);
    return { success: true, enabled: true, lan: lanBroadcast.statusFor(this.getServer(serverId)) };
  }

  async syncLanBroadcast(serverId) {
    const lanBroadcast = require('./lanBroadcast');
    const server = this.getServer(serverId);
    if (!server || this.isBedrockConnect(server) || Number(server.lan_broadcast) !== 1) {
      lanBroadcast.stop(serverId);
      return null;
    }
    if (this.isBedrockConnectActive()) {
      lanBroadcast.stop(serverId);
      return lanBroadcast.statusFor(server);
    }
    if (Number(server.port) === lanBroadcast.DISCOVERY_PORT) return lanBroadcast.statusFor(server);
    if (server.status === 'creating') {
      lanBroadcast.stop(serverId);
      return lanBroadcast.statusFor(server);
    }
    if (lanBroadcast.isActive(serverId)) return lanBroadcast.statusFor(server);
    lanBroadcast.stop(serverId);
    const session = await lanBroadcast.startAndWait(server);
    db.prepare('UPDATE servers SET lan_proxy_port = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(session.proxyPort, serverId);
    this.invalidateServerCache(serverId);
    return lanBroadcast.statusFor(this.getServer(serverId));
  }

  async restoreLanBroadcasts() {
    const lanBroadcast = require('./lanBroadcast');
    if (this.isBedrockConnectActive()) {
      logger.info('Skipping LAN broadcast restore because Bedrock Connect is running');
      return;
    }
    const rows = db.prepare("SELECT id FROM servers WHERE lan_broadcast = 1 AND kind != 'bedrock_connect'").all();
    for (const row of rows) {
      try {
        await this.syncLanBroadcast(row.id);
      } catch (err) {
        logger.warn(`Could not restore LAN broadcast for server ${row.id}: ${err.message}`);
      }
    }
  }

  async completePendingLanBroadcastIfNeeded(serverId) {
    const pending = this.getPendingLanBroadcast();
    if (!pending || Number(pending.occupantId) !== Number(serverId)) return null;
    this.setPendingLanBroadcast(null);
    const occupant = this.getServer(serverId);
    if (occupant && occupant.pending_port) {
      await this.commitPortChange(serverId, occupant.pending_port);
    } else if (occupant && Number(occupant.port) === BEDROCK_CONNECT_PORT) {
      const nextPort = pending.nextPort || await this.nextAvailablePort({ exclude: [BEDROCK_CONNECT_PORT] });
      await this.commitPortChange(serverId, nextPort);
    }
    const enableIds = pending.enableIds || [serverId];
    for (const id of enableIds) {
      db.prepare('UPDATE servers SET lan_broadcast = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
      this.invalidateServerCache(id);
      try { await this.syncLanBroadcast(id); } catch (err) {
        logger.warn(`LAN broadcast failed for server ${id}: ${err.message}`);
      }
    }
    return { success: true };
  }

  async nextAvailablePort({ exclude = [] } = {}) {
    const skip = new Set(exclude.map(Number));
    const { available } = await this.getAllPorts();
    const match = available.find(item => !skip.has(item.port));
    if (!match) throw new Error('No available UDP ports are left in the manager ranges');
    return match.port;
  }

  async previewBedrockConnect() {
    const existing = this.getBedrockConnectServer();
    const pending = this.getPendingBedrockConnect();
    if (existing) {
      return { exists: true, pending: null, conflict: null, port: BEDROCK_CONNECT_PORT };
    }
    const occupant = db.prepare('SELECT * FROM servers WHERE port = ?').get(BEDROCK_CONNECT_PORT);
    if (!occupant) {
      const lanBroadcast = require('./lanBroadcast');
      const lanActive = lanBroadcast.hasAnyActive();
      const free = lanActive || await this.isUdpPortAvailable(BEDROCK_CONNECT_PORT);
      return {
        exists: false,
        pending,
        conflict: null,
        port: BEDROCK_CONNECT_PORT,
        portBlocked: !free,
        lanWillStop: lanActive,
      };
    }
    const nextPort = await this.nextAvailablePort({ exclude: [BEDROCK_CONNECT_PORT, occupant.port] });
    return {
      exists: false,
      pending,
      port: BEDROCK_CONNECT_PORT,
      conflict: {
        serverId: occupant.id,
        serverName: occupant.name,
        status: occupant.status,
        currentPort: occupant.port,
        nextPort,
      },
    };
  }

  async createBedrockConnect({ acceptConflict = false, restartMode = 'immediate' } = {}) {
    if (this.getBedrockConnectServer()) {
      throw new Error('A Bedrock Connect server already exists');
    }
    if (this.getPendingBedrockConnect()) {
      throw new Error('Bedrock Connect is already scheduled after a warned restart');
    }
    const preview = await this.previewBedrockConnect();
    if (preview.portBlocked) {
      throw new Error(`UDP port ${BEDROCK_CONNECT_PORT} is in use by another process. Free it before creating Bedrock Connect.`);
    }
    if (preview.conflict && !acceptConflict) {
      const err = new Error(`Port ${BEDROCK_CONNECT_PORT} is used by ${preview.conflict.serverName}`);
      err.code = 'PORT_CONFLICT';
      err.conflict = preview.conflict;
      throw err;
    }
    if (preview.conflict) {
      const occupant = this.getServer(preview.conflict.serverId);
      if (occupant.status === 'running' && restartMode === 'warned') {
        await this.queuePortChange(occupant.id, preview.conflict.nextPort, { restartRequired: true });
        this.scheduleWarnedRestart(occupant.id);
        this.setPendingBedrockConnect({
          occupantId: occupant.id,
          nextPort: preview.conflict.nextPort,
          createdAt: new Date().toISOString(),
        });
        return {
          pending: true,
          conflict: preview.conflict,
          message: `${occupant.name} will move to port ${preview.conflict.nextPort} after the five-minute restart. Bedrock Connect will be created then.`,
        };
      }
      await this.relocateServerForBedrockConnect(occupant.id, preview.conflict.nextPort, restartMode);
    }

    return this.provisionBedrockConnect();
  }

  async relocateServerForBedrockConnect(serverId, nextPort) {
    const occupant = this.getServer(serverId);
    const wasRunning = occupant.status === 'running';
    if (wasRunning) {
      await this.stopServer(serverId);
    }
    await this.commitPortChange(serverId, nextPort);
    if (wasRunning) {
      await this.startServer(serverId);
    }
  }

  async completePendingBedrockConnectIfNeeded(serverId) {
    const pending = this.getPendingBedrockConnect();
    if (!pending || Number(pending.occupantId) !== Number(serverId)) return null;
    this.setPendingBedrockConnect(null);
    if (this.getBedrockConnectServer()) return null;
    const occupant = this.getServer(serverId);
    if (occupant && occupant.pending_port) {
      await this.commitPortChange(serverId, occupant.pending_port);
    } else if (occupant && Number(occupant.port) === BEDROCK_CONNECT_PORT) {
      const nextPort = pending.nextPort || await this.nextAvailablePort({ exclude: [BEDROCK_CONNECT_PORT] });
      await this.commitPortChange(serverId, nextPort);
    }
    return this.provisionBedrockConnect();
  }

  async provisionBedrockConnect() {
    const bedrockConnect = require('./bedrockConnect');
    await bedrockConnect.assertJavaAvailable();
    const jar = await bedrockConnect.ensureJarAvailable();
    const serverPath = path.join(BASE_DIR, 'bedrock-connect');
    fs.mkdirSync(serverPath, { recursive: true });
    const installed = bedrockConnect.installJarInto(serverPath, jar.tag);

    const insert = db.prepare(`
      INSERT INTO servers (name, version, port, max_players, whitelist_mode, difficulty, gamemode,
        server_description, server_motd, status, data_path, kind)
      VALUES (?, ?, ?, 0, 0, 'peaceful', 'survival', ?, ?, 'stopped', ?, 'bedrock_connect')
    `);
    const result = insert.run(
      bedrockConnect.DISPLAY_NAME,
      installed.tag,
      BEDROCK_CONNECT_PORT,
      'Console server list for Xbox, PlayStation, and Nintendo Switch',
      'Bedrock Connect',
      serverPath
    );
    const serverId = result.lastInsertRowid;
    this.registerPort(serverId, BEDROCK_CONNECT_PORT, 'udp');
    this.invalidateServerCache(serverId);
    this.setPendingBedrockConnect(null);
    logger.info(`Created Bedrock Connect on port ${BEDROCK_CONNECT_PORT} (${installed.tag})`);
    return { id: serverId, name: bedrockConnect.DISPLAY_NAME, port: BEDROCK_CONNECT_PORT, version: installed.tag };
  }

  listBedrockConnectVersions() {
    const bedrockConnect = require('./bedrockConnect');
    const existing = this.getBedrockConnectServer();
    return {
      installed: existing?.version || null,
      latestStored: bedrockConnect.latestStoredVersion()?.tag || null,
      stored: bedrockConnect.listVersions().map(item => ({
        tag: item.tag,
        publishedAt: item.publishedAt,
        downloadedAt: item.downloadedAt,
      })),
    };
  }

  async checkBedrockConnectUpdates() {
    const bedrockConnect = require('./bedrockConnect');
    const synced = await bedrockConnect.syncLatest({ download: true });
    const existing = this.getBedrockConnectServer();
    return {
      latestTag: synced.latestTag,
      installed: existing?.version || null,
      stored: synced.stored.map(item => ({
        tag: item.tag,
        publishedAt: item.publishedAt,
        downloadedAt: item.downloadedAt,
      })),
    };
  }

  async queuePortChange(serverId, newPort, { restartRequired = false } = {}) {
    const server = this.getServer(serverId);
    if (!server) throw new Error('Server not found');
    if (this.isBedrockConnect(server) && Number(newPort) !== BEDROCK_CONNECT_PORT) {
      throw new Error('Bedrock Connect must stay on UDP port 19132');
    }
    const port = parseInt(newPort, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Port must be between 1 and 65535');
    }
    if (port === Number(server.port) && !server.pending_port) return { success: true, port };

    const taken = db.prepare('SELECT id, name FROM servers WHERE port = ? AND id != ?').get(port, serverId);
    if (taken) throw new Error(`Port ${port} is already assigned to ${taken.name}`);
    const pendingTaken = db.prepare('SELECT id, name FROM servers WHERE pending_port = ? AND id != ?').get(port, serverId);
    if (pendingTaken) throw new Error(`Port ${port} is already reserved for ${pendingTaken.name}`);

    const bc = this.getBedrockConnectServer();
    if (port === BEDROCK_CONNECT_PORT && bc && Number(bc.id) !== Number(serverId)) {
      throw new Error('UDP port 19132 is reserved for Bedrock Connect');
    }

    if (port !== Number(server.port) && !(await this.isUdpPortAvailable(port))) {
      throw new Error(`UDP port ${port} is already in use by another process`);
    }

    if (restartRequired || server.status === 'running') {
      db.prepare(`
        UPDATE servers SET pending_port = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(port, serverId);
      this.invalidateServerCache(serverId);
      this.markRestartRequired(serverId, `Port will change to ${port}`);
      return { success: true, port, pending: true };
    }

    await this.commitPortChange(serverId, port);
    return { success: true, port, pending: false };
  }

  async commitPortChange(serverId, newPort) {
    const server = this.getServer(serverId);
    if (!server) throw new Error('Server not found');
    const port = parseInt(newPort, 10);
    if (this.isBedrockConnect(server) && port !== BEDROCK_CONNECT_PORT) {
      throw new Error('Bedrock Connect must stay on UDP port 19132');
    }

    if (!this.isBedrockConnect(server)) {
      this.writeRuntimeServerProperties({ ...server, port });
    }

    db.prepare(`
      UPDATE servers
      SET port = ?, pending_port = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(port, serverId);
    this.unregisterPorts(serverId);
    this.registerPort(serverId, port, 'udp');
    this.invalidateServerCache(serverId);
    logger.info(`Server ${server.name} is now on port ${port}`);
    try {
      if (Number(this.getServer(serverId)?.lan_broadcast) === 1) {
        await this.syncLanBroadcast(serverId);
      }
    } catch (err) {
      logger.warn(`LAN broadcast did not restart after port change for ${server.name}: ${err.message}`);
    }
    return { success: true, port };
  }

  // ========== SERVER LIFECYCLE ==========

  async createServer(config) {
    const { name, port, version, maxPlayers, description, gamemode, difficulty } = config;

    // Validate port
    if (port < 1 || port > 65535) {
      throw new Error('Port must be between 1 and 65535');
    }
    if (Number(port) === BEDROCK_CONNECT_PORT && (this.getBedrockConnectServer() || this.getPendingBedrockConnect())) {
      throw new Error('UDP port 19132 is reserved for Bedrock Connect');
    }

    // Check port availability
    const existing = db.prepare('SELECT * FROM servers WHERE port = ? OR name = ?').get(port, name);
    if (existing) {
      throw new Error('Port or server name already in use');
    }
    const pendingTaken = db.prepare('SELECT name FROM servers WHERE pending_port = ?').get(port);
    if (pendingTaken) {
      throw new Error(`Port ${port} is already reserved for ${pendingTaken.name}`);
    }

    if (!(await this.isUdpPortAvailable(port))) {
      throw new Error(`UDP port ${port} is already in use by another process`);
    }

    const serverPath = path.join(BASE_DIR, name);
    fs.mkdirSync(serverPath, { recursive: true });

    const insert = db.prepare(`
      INSERT INTO servers (name, version, port, max_players, whitelist_mode, difficulty, gamemode,
        server_description, server_motd, status, data_path, lan_broadcast)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, 'creating', ?, 1)
    `);
    const result = insert.run(
      name, version || 'latest', port, maxPlayers || 10,
      difficulty || 'peaceful', gamemode || 'survival',
      description || 'Minecraft Bedrock Server',
      description || 'Minecraft Bedrock Server',
      serverPath
    );
    const serverId = result.lastInsertRowid;
    this.registerPort(serverId, port, 'udp');
    this.invalidateServerCache(serverId);
    this.broadcastServerStatus(serverId);

    const job = this.finishCreateServer(serverId, {
      name,
      port,
      maxPlayers: maxPlayers || 10,
      description: description || 'Minecraft Bedrock Server',
      gamemode: gamemode || 'survival',
      difficulty: difficulty || 'peaceful',
      version: version || 'latest',
      serverPath,
    }).finally(() => this.provisionJobs.delete(Number(serverId)));
    this.provisionJobs.set(Number(serverId), job);

    logger.info(`Queued server create: ${name} on port ${port}`);
    return { id: serverId, name, port, status: 'creating', dataPath: serverPath };
  }

  async finishCreateServer(serverId, config) {
    const { name, port, maxPlayers, description, gamemode, difficulty, version, serverPath } = config;
    try {
      await this.downloadServer(serverPath, version);
      if (!this.getServer(serverId)) return;

      fs.mkdirSync(path.join(serverPath, 'behavior_packs'), { recursive: true });
      fs.mkdirSync(path.join(serverPath, 'texture_packs'), { recursive: true });
      fs.mkdirSync(path.join(serverPath, 'worlds'), { recursive: true });
      fs.mkdirSync(path.join(serverPath, 'resource_packs'), { recursive: true });

      this.writeServerProperties(
        path.join(serverPath, 'server.properties'),
        this.bedrockRuntimeProperties({
          name,
          port,
          max_players: maxPlayers,
          difficulty,
          gamemode,
          server_description: description,
          data_path: serverPath,
        })
      );
      fs.writeFileSync(path.join(serverPath, 'allowlist.json'), '[]\n');
      fs.writeFileSync(path.join(serverPath, 'permissions.json'), '[]\n');

      db.prepare('UPDATE servers SET status = ?, pending_restart_reason = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run('stopped', serverId);
      this.invalidateServerCache(serverId);
      this.broadcastServerStatus(serverId);
      logger.info(`Created server: ${name} on port ${port}`);
    } catch (err) {
      logger.error(`Failed to finish creating ${name}: ${err.message}`);
      if (!this.getServer(serverId)) return;
      db.prepare('UPDATE servers SET status = ?, pending_restart = 0, pending_restart_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run('stopped', `Create failed: ${err.message}`, serverId);
      this.invalidateServerCache(serverId);
      this.broadcastServerStatus(serverId);
    }
  }

  async resolveBedrockDownloadUrl(version) {
    const axios = require('axios');
    const headers = {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/json',
    };
    try {
      const api = await axios.get('https://net-secondary.web.minecraft-services.net/api/v1.0/download/links', {
        headers: { ...headers, Accept: 'application/json' },
        timeout: 20000,
      });
      const links = api.data?.result?.links || api.data?.links || [];
      const linux = links.find(item =>
        /serverBedrockLinux/i.test(item.downloadType || '')
        || /bin-linux/i.test(item.downloadUrl || item.url || '')
      );
      const url = linux?.downloadUrl || linux?.url;
      if (url) return url;
    } catch (err) {
      logger.warn(`Bedrock download API lookup failed: ${err.message}`);
    }

    const page = await axios.get('https://www.minecraft.net/en-us/download/server/bedrock', {
      headers,
      timeout: 20000,
      maxRedirects: 5,
    });
    const html = String(page.data || '');
    const matches = [...html.matchAll(/https:\/\/www\.minecraft\.net\/bedrockdedicatedserver\/bin-linux\/bedrock-server-[0-9.]+\.zip/g)]
      .map(match => match[0]);
    if (version && version !== 'latest') {
      const pinned = matches.find(url => url.includes(version));
      if (pinned) return pinned;
    }
    if (matches[0]) return matches[0];
    throw new Error('Could not resolve the official Bedrock Dedicated Server download URL');
  }

  async downloadServer(targetDir, version) {
    logger.info(`Downloading Minecraft Bedrock server to ${targetDir}`);
    const zipPath = path.join(targetDir, 'bedrock_server.zip');
    try {
      const downloadUrl = await this.resolveBedrockDownloadUrl(version);
      logger.info(`Fetching Bedrock Dedicated Server from ${downloadUrl}`);
      await execAsync(
        `curl -fsSL -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" -o "${zipPath}" "${downloadUrl}"`,
        { timeout: 180000 }
      );
      if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size < 1000000) {
        throw new Error('Download failed or file too small');
      }
      await execAsync(`unzip -o -q "${zipPath}" -d "${targetDir}"`, { timeout: 120000 });
      try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
      const serverBin = path.join(targetDir, 'bedrock_server');
      if (!fs.existsSync(serverBin)) {
        throw new Error('Archive did not contain bedrock_server');
      }
      fs.chmodSync(serverBin, '755');
    } catch (err) {
      logger.warn(`Direct download failed: ${err.message}`);
      try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
      if (String(process.env.ALLOW_STUB_SERVER || '') === '1') {
        await this.createStubServer(targetDir);
        return;
      }
      throw err;
    }
  }

  async createStubServer(targetDir) {
    // Create minimal server structure for testing/development
    const serverBin = path.join(targetDir, 'bedrock_server');
    
    // Create a placeholder script that simulates the server
    fs.writeFileSync(serverBin, `#!/bin/bash
# Minecraft Bedrock Server Stub
# This is a placeholder - install the actual server binary
echo "[Bedrock Server] Starting server..."
echo "[Bedrock Server] Server started on port $PORT"
while true; do
  read -r line || true
  if [ "$line" = "stop" ]; then
    echo "[Bedrock Server] Server stopped"
    exit 0
  fi
  echo "[Bedrock Server] Command received: $line"
done
`);
    fs.chmodSync(serverBin, '755');

    // Create default world
    const worldDir = path.join(targetDir, 'worlds', 'new_world');
    fs.mkdirSync(worldDir, { recursive: true });
    fs.writeFileSync(path.join(worldDir, 'level.dat'), '');
    
    // Create user data dir
    fs.mkdirSync(path.join(targetDir, 'user_data'), { recursive: true });
    
    logger.info(`Created stub server at ${targetDir}`);
  }

  isStubBedrockBinary(filePath) {
    try {
      const header = fs.readFileSync(filePath).subarray(0, 120).toString('utf8');
      return header.startsWith('#!') || /placeholder|Bedrock Server Stub/i.test(header);
    } catch {
      return true;
    }
  }

  async startBedrockConnect(server) {
    this.stopLanBroadcastsForBedrockConnect();
    const bedrockConnect = require('./bedrockConnect');
    await bedrockConnect.assertJavaAvailable();
    const installed = bedrockConnect.installedJar(server.data_path)
      || bedrockConnect.installJarInto(server.data_path, server.version);
    const sessionKey = this.sessionKey(server.id);
    try {
      const { spawn: spawnPty } = require('node-pty');
      const pty = spawnPty('java', [
        '-jar', installed.jarPath,
        'nodb=true',
        `port=${BEDROCK_CONNECT_PORT}`,
        'bindip=0.0.0.0',
      ], {
        name: 'xterm-color',
        cols: 120,
        rows: 30,
        cwd: server.data_path,
        env: { ...process.env },
      });

      this.ptySessions.set(sessionKey, pty);
      this.setupPtyOutputBroadcast(server.id, pty);
      db.prepare('UPDATE servers SET status = ?, started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run('starting', server.id);
      this.invalidateServerCache(server.id);
      this.broadcastServerStatus(server.id);

      setTimeout(() => {
        if (this.ptySessions.has(sessionKey)) {
          db.prepare(`
            UPDATE servers
            SET status = ?, pending_restart = 0, pending_restart_reason = NULL,
              pending_restart_at = NULL, restart_scheduled_at = NULL,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run('running', server.id);
          this.invalidateServerCache(server.id);
          logger.info('Bedrock Connect started');
          this.broadcastServerStatus(server.id);
        }
      }, 3000);

      return { success: true, message: 'Bedrock Connect starting...' };
    } catch (err) {
      logger.error(`Failed to start Bedrock Connect: ${err.message}`);
      db.prepare('UPDATE servers SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run('stopped', server.id);
      this.invalidateServerCache(server.id);
      throw new Error(`Failed to start Bedrock Connect: ${err.message}`);
    }
  }

  async startServer(serverId) {
    const sessionKey = this.sessionKey(serverId);
    const server = this.getServer(serverId);
    if (!server) throw new Error('Server not found');
    if (server.status === 'running') throw new Error('Server already running');
    if (server.status === 'creating') throw new Error('Server is still being built');

    if (server.pending_port) {
      await this.commitPortChange(serverId, server.pending_port);
    }
    const current = this.getServer(serverId);
    const serverPath = current.data_path;

    if (this.isBedrockConnect(current)) {
      const result = await this.startBedrockConnect(current);
      await this.completePendingBedrockConnectIfNeeded(serverId);
      return result;
    }

    const serverBin = path.join(serverPath, 'bedrock_server');

    // Check if binary exists
    if (!fs.existsSync(serverBin)) {
      throw new Error(`Server binary not found at ${serverBin}. Please install the server first.`);
    }
    if (this.isStubBedrockBinary(serverBin)) {
      throw new Error('This instance has a placeholder binary, not Minecraft Bedrock Dedicated Server. Delete it and create the server again, or unzip the official files into this server directory.');
    }

    try {
      this.writeRuntimeServerProperties(current);
      fs.chmodSync(serverBin, '755');

      const { spawn: spawnPty } = require('node-pty');
      const pty = spawnPty(serverBin, [], {
        name: 'xterm-color',
        cols: 120,
        rows: 30,
        cwd: serverPath,
        env: {
          ...process.env,
          LD_LIBRARY_PATH: `${serverPath}:.`,
          PORT: String(current.port),
        },
      });

      this.ptySessions.set(sessionKey, pty);

      // Connect PTY output to Socket.IO for real-time terminal streaming
      this.setupPtyOutputBroadcast(serverId, pty);

      // Update status
      db.prepare('UPDATE servers SET status = ?, started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run('starting', serverId);
      this.invalidateServerCache(serverId);
      this.broadcastServerStatus(serverId);

      // Wait a moment then mark as running
      setTimeout(() => {
        if (this.ptySessions.has(sessionKey)) {
          db.prepare(`
            UPDATE servers
            SET status = ?, pending_restart = 0, pending_restart_reason = NULL,
              pending_restart_at = NULL, restart_scheduled_at = NULL,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `)
            .run('running', serverId);
          // Invalidate cache so next getServer() reads fresh status
          this.invalidateServerCache(serverId);
          logger.info(`Server ${server.name} started successfully`);
          this.broadcastServerStatus(serverId);
        }
      }, 3000);

      await this.completePendingBedrockConnectIfNeeded(serverId);
      await this.completePendingLanBroadcastIfNeeded(serverId);
      if (Number(this.getServer(serverId)?.lan_broadcast) === 1) {
        try {
          await this.syncLanBroadcast(serverId);
        } catch (err) {
          logger.warn(`LAN broadcast did not start with ${current.name}: ${err.message}`);
        }
      }
      return { success: true, message: 'Server starting...' };
    } catch (err) {
      logger.error(`Failed to start server ${server.name}: ${err.message}`);
      db.prepare('UPDATE servers SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run('stopped', serverId);
      // Invalidate cache so next getServer() reads fresh status
      this.invalidateServerCache(serverId);
      throw new Error(`Failed to start server: ${err.message}`);
    }
  }

  async stopServer(serverId) {
    const sessionKey = this.sessionKey(serverId);
    const server = this.getServer(serverId);
    if (!server) throw new Error('Server not found');
    this.cancelWarnedRestart(serverId, { broadcast: false });
    if (server.status === 'creating') {
      throw new Error('Server is still being built');
    }
    if (server.status === 'stopped') throw new Error('Server already stopped');

    const pty = this.ptySessions.get(sessionKey);
    if (pty) {
      if (this.isBedrockConnect(server)) {
        try { pty.kill(); } catch { /* ignore */ }
        await new Promise((resolve) => {
          const timeout = setTimeout(resolve, 3000);
          pty.on('exit', () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      } else {
        pty.write('stop\n');
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            pty.kill();
            resolve();
          }, 15000);
          pty.on('exit', () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      }
      this.ptySessions.delete(sessionKey);
    }

    db.prepare('UPDATE servers SET status = ?, pid = NULL, started_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run('stopped', serverId);
    // Invalidate cache so next getServer() reads fresh status
    this.invalidateServerCache(serverId);

    logger.info(`Server ${server.name} stopped`);
    this.broadcastServerStatus(serverId);
    if (this.isBedrockConnect(server)) {
      await this.restoreLanBroadcasts();
    }
    return { success: true, message: 'Server stopped' };
  }

  async restartServer(serverId) {
    await this.stopServer(serverId);
    await this.startServer(serverId);
    await this.completePendingBedrockConnectIfNeeded(serverId);
  }

  scheduleWarnedRestart(serverId) {
    const key = this.sessionKey(serverId);
    const server = this.getServer(serverId);
    if (!server) throw new Error('Server not found');
    if (this.isBedrockConnect(server)) {
      throw new Error('Bedrock Connect does not support warned restarts');
    }
    if (server.status !== 'running' || !this.ptySessions.has(key)) {
      throw new Error('Server must be running to schedule a warned restart');
    }
    if (this.scheduledRestarts.has(key)) {
      throw new Error('A warned restart is already scheduled for this server');
    }

    const scheduledAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    db.prepare(`
      UPDATE servers SET restart_scheduled_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(scheduledAt, serverId);
    this.invalidateServerCache(serverId);

    const announce = (minutes) => {
      if (!this.ptySessions.has(key)) return;
      this.sendCommand(
        serverId,
        `say [Server Manager] Server restart in ${minutes} minute${minutes === 1 ? '' : 's'}. Please prepare to disconnect.`
      );
    };

    announce(5);
    const timers = [
      setTimeout(() => announce(2), 3 * 60 * 1000),
      setTimeout(() => announce(1), 4 * 60 * 1000),
      setTimeout(async () => {
        this.scheduledRestarts.delete(key);
        db.prepare('UPDATE servers SET restart_scheduled_at = NULL WHERE id = ?').run(serverId);
        this.invalidateServerCache(serverId);
        try {
          await this.restartServer(serverId);
        } catch (err) {
          logger.error(`Warned restart failed for ${server.name}: ${err.message}`);
          this.markServerStopped(serverId);
        }
      }, 5 * 60 * 1000),
    ];
    this.scheduledRestarts.set(key, { scheduledAt, timers });
    this.broadcastServerStatus(serverId);
    logger.info(`Scheduled warned restart for ${server.name} at ${scheduledAt}`);
    return { success: true, scheduledAt };
  }

  async deleteServer(serverId) {
    const server = this.getServer(serverId);
    if (!server) throw new Error('Server not found');
    const wasBedrockConnect = this.isBedrockConnect(server);
    require('./lanBroadcast').stop(serverId);

    if (server.status === 'creating') {
      const job = this.provisionJobs.get(Number(serverId));
      this.provisionJobs.delete(Number(serverId));
      if (job && typeof job.catch === 'function') job.catch(() => {});
    } else if (server.status !== 'stopped') {
      await this.stopServer(serverId);
    }

    // Remove data directory
    const serverPath = server.data_path;
    if (fs.existsSync(serverPath)) {
      fs.rmSync(serverPath, { recursive: true, force: true });
    }

    // Unregister ports
    this.unregisterPorts(serverId);

    const pending = this.getPendingBedrockConnect();
    if (pending && (Number(pending.occupantId) === Number(serverId) || this.isBedrockConnect(server))) {
      this.setPendingBedrockConnect(null);
    }
    const pendingLan = this.getPendingLanBroadcast();
    if (pendingLan && (
      Number(pendingLan.occupantId) === Number(serverId)
      || (pendingLan.enableIds || []).some(id => Number(id) === Number(serverId))
    )) {
      this.setPendingLanBroadcast(null);
    }

    // Remove from database
    db.prepare('DELETE FROM servers WHERE id = ?').run(serverId);
    
    this.invalidateServerCache(serverId);
    logger.info(`Deleted server: ${server.name}`);
    if (wasBedrockConnect) {
      await this.restoreLanBroadcasts();
    }
    return { success: true, message: 'Server deleted' };
  }

  // ========== SERVER COMMANDS ==========

  sendCommand(serverId, command) {
    const server = this.getServer(serverId);
    if (this.isBedrockConnect(server)) {
      throw new Error('Bedrock Connect does not accept console commands');
    }
    const pty = this.ptySessions.get(this.sessionKey(serverId));
    if (!pty) {
      this.markServerStopped(serverId);
      throw new Error('Server process is not running. Its status has been corrected to Offline.');
    }
    pty.write(`${command}\n`);
    return { success: true, command };
  }

  // ========== SERVER PROPERTIES ==========

  async updateSettings(serverId, settings) {
    const server = this.getServer(serverId);
    if (!server) throw new Error('Server not found');

    if (this.isBedrockConnect(server)) {
      throw new Error('Bedrock Connect settings cannot be changed');
    }

    const requestedPort = settings.port;
    const rest = { ...settings };
    delete rest.port;

    const propsPath = path.join(server.data_path, 'server.properties');
    const currentProps = this.readServerProperties(propsPath);
    
    // Map settings to properties
    const mapping = {
      max_players: 'max-players',
      difficulty: 'difficulty',
      gamemode: 'gamemode',
      whitelist_mode: 'allow-list',
      server_description: 'server-name',
      server_motd: 'server-name',
      texture_pack_required: 'texturepack-required',
      enable_cheats: 'allow-cheats',
      default_1st_person: 'default-player-permission-level',
      view_distance: 'view-distance',
      tick_distance: 'tick-distance',
      player_idle_timeout: 'player-idle-timeout',
      allow_third_party_requests: 'allow-third-party-requests',
      allow_third_party_pictures: 'allow-third-party-pictures',
      online_mode: 'online-mode',
      require_secure_chat: 'require-secure-chat',
      server_authoritative_inventory: 'server-authoritative-vanilla-inventory',
      enable_player_data_initialization: 'enable-player-data-initialization',
      level_seed: 'level-seed',
      default_player_permission: 'default-player-permission-level',
      auto_ice: 'auto-ice',
      natural_regeneration: 'natural-regeneration',
      remote_discovery: 'remote-discovery',
      tx_rate: 'tx-rate',
    };

    const booleanSettings = new Set([
      'whitelist_mode', 'texture_pack_required', 'enable_cheats', 'server_authoritative',
      'allow_third_party_requests', 'allow_third_party_pictures', 'online_mode',
      'require_secure_chat', 'server_authoritative_inventory',
      'enable_player_data_initialization', 'auto_ice', 'natural_regeneration',
      'remote_discovery',
    ]);
    for (const [key, value] of Object.entries(rest)) {
      const propKey = mapping[key];
      if (!propKey || value == null) continue;
      currentProps[propKey] = booleanSettings.has(key)
        ? String(value === true || value === 1 || value === '1' || value === 'true')
        : String(value);
    }

    this.writeServerProperties(propsPath, currentProps);

    // Update database
    const update = db.prepare(`
      UPDATE servers SET updated_at = CURRENT_TIMESTAMP,
        max_players = COALESCE(?, max_players),
        difficulty = COALESCE(?, difficulty),
        gamemode = COALESCE(?, gamemode),
        whitelist_mode = COALESCE(?, whitelist_mode),
        server_description = COALESCE(?, server_description),
        server_motd = COALESCE(?, server_motd),
        texture_pack_required = COALESCE(?, texture_pack_required),
        enable_cheats = COALESCE(?, enable_cheats),
        server_authoritative = COALESCE(?, server_authoritative),
        default_1st_person = COALESCE(?, default_1st_person)
      WHERE id = ?
    `);
    const toSqliteBoolean = (value) => value == null
      ? null
      : Number(value === true || value === 1 || value === '1' || value === 'true');

    update.run(
      rest.max_players ?? null,
      rest.difficulty ?? null,
      rest.gamemode ?? null,
      toSqliteBoolean(rest.whitelist_mode),
      rest.server_description ?? null,
      rest.server_motd ?? null,
      toSqliteBoolean(rest.texture_pack_required),
      toSqliteBoolean(rest.enable_cheats),
      toSqliteBoolean(rest.server_authoritative),
      toSqliteBoolean(rest.default_1st_person),
      serverId
    );

    logger.info(`Updated settings for server ${server.name}`);
    
    // Invalidate cache so next getServer() reads fresh data from DB
    this.invalidateServerCache(serverId);
    if (server.status === 'running' && Object.keys(rest).length > 0) {
      this.markRestartRequired(serverId, 'Server settings changed');
    }

    if (requestedPort != null && requestedPort !== '' && Number(requestedPort) !== Number(server.port)) {
      return this.queuePortChange(serverId, requestedPort);
    }
    return { success: true };
  }

  readServerProperties(filePath) {
    const props = {};
    if (!fs.existsSync(filePath)) return props;
    
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx > -1) {
        const key = trimmed.substring(0, idx).trim();
        const value = trimmed.substring(idx + 1).trim();
        props[key] = value;
      }
    }
    return props;
  }

  ipv6PortFor(port) {
    const v4 = Number(port);
    if (v4 === BEDROCK_CONNECT_PORT) return 19133;
    if (v4 === 19133) return 19134;
    return v4 + 1;
  }

  bedrockRuntimeProperties(server, existing = {}) {
    const v4 = Number(server.port);
    const nativeLan = v4 === BEDROCK_CONNECT_PORT;
    const props = { ...existing };
    delete props['enable-cheats'];
    delete props['default-player-permission'];
    delete props['server-authoritative'];
    delete props['server-description'];
    delete props['texturepack-name'];
    delete props['texturepacks-required'];
    delete props['content-log-file-enable'];
    delete props['compression-threshold-kb'];
    return {
      ...props,
      'server-name': server.name,
      'level-name': existing['level-name'] || server.name,
      'server-port': String(v4),
      'server-portv6': String(this.ipv6PortFor(v4)),
      'enable-lan-visibility': nativeLan ? 'true' : 'false',
      'max-players': String(server.max_players || existing['max-players'] || 10),
      'allow-list': existing['allow-list'] || 'false',
      difficulty: server.difficulty || existing.difficulty || 'peaceful',
      gamemode: server.gamemode || existing.gamemode || 'survival',
      'allow-cheats': existing['allow-cheats'] || 'true',
      'default-player-permission-level': existing['default-player-permission-level'] || 'member',
      'online-mode': existing['online-mode'] || 'true',
      'texturepack-required': existing['texturepack-required'] || 'false',
      'content-log-file-enabled': existing['content-log-file-enabled'] || 'false',
      'compression-threshold': existing['compression-threshold'] || '1',
    };
  }

  writeRuntimeServerProperties(server) {
    const propsPath = path.join(server.data_path, 'server.properties');
    const current = this.readServerProperties(propsPath);
    this.writeServerProperties(propsPath, this.bedrockRuntimeProperties(server, current));
  }

  writeServerProperties(filePath, props) {
    const lines = [];
    lines.push('# Server Properties');
    lines.push(`# Generated: ${new Date().toISOString()}`);
    lines.push('');
    
    for (const [key, value] of Object.entries(props)) {
      lines.push(`${key}=${value}`);
    }
    
    fs.writeFileSync(filePath, lines.join('\n') + '\n');
  }

  // ========== SERVER UPDATES ==========

  async updateServer(serverId, targetVersion) {
    const server = this.getServer(serverId);
    if (!server) throw new Error('Server not found');
    if (server.status === 'creating') throw new Error('Server is still being built');

      if (this.isBedrockConnect(server)) {
        const bedrockConnect = require('./bedrockConnect');
        if (!targetVersion || targetVersion === 'latest') {
          try {
            await bedrockConnect.syncLatest({ download: true });
          } catch (err) {
            logger.warn(`Bedrock Connect latest check failed, using stored JAR: ${err.message}`);
          }
          await bedrockConnect.ensureJarAvailable();
        }
        const installed = bedrockConnect.installJarInto(server.data_path, targetVersion || 'latest');
      const fromVersion = server.version;
      db.prepare('UPDATE servers SET version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(installed.tag, serverId);
      db.prepare(`
        INSERT INTO update_history (server_id, from_version, to_version, status, notes)
        VALUES (?, ?, ?, 'completed', ?)
      `).run(serverId, fromVersion, installed.tag, 'Bedrock Connect JAR updated');
      this.invalidateServerCache(serverId);
      if (server.status === 'running') {
        this.markRestartRequired(serverId, `Bedrock Connect ${installed.tag} is ready`);
      }
      return { success: true, fromVersion, toVersion: installed.tag };
    }

    const fromVersion = server.version;
    
    // Backup current addons and world data
    const backupPath = path.join(server.data_path, 'backup_' + Date.now());
    await this.backupServerData(server.data_path, backupPath);

    try {
      // Download new version
      await this.downloadServer(server.data_path, targetVersion || 'latest');

      // Restore addons and world data
      await this.restoreServerData(server.data_path, backupPath);

      // Update version
      db.prepare('UPDATE servers SET version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(targetVersion || 'latest', serverId);

      // Log update
      db.prepare(`
        INSERT INTO update_history (server_id, from_version, to_version, status, notes)
        VALUES (?, ?, ?, 'completed', ?)
      `).run(serverId, fromVersion, targetVersion || 'latest', 'Updated successfully');

      logger.info(`Server ${server.name} updated from ${fromVersion} to ${targetVersion || 'latest'}`);
      return { success: true, fromVersion, toVersion: targetVersion };
    } catch (err) {
      // Restore from backup on failure
      logger.error(`Update failed for ${server.name}, restoring backup`);
      await this.restoreServerData(server.data_path, backupPath);
      throw new Error(`Update failed: ${err.message}`);
    }
  }

  async backupServerData(serverPath, backupPath) {
    fs.mkdirSync(backupPath, { recursive: true });
    
    // Backup important directories that should persist
    const dirsToBackup = ['behavior_packs', 'texture_packs', 'resource_packs', 'worlds', 'user_data'];
    
    for (const dir of dirsToBackup) {
      const src = path.join(serverPath, dir);
      const dst = path.join(backupPath, dir);
      if (fs.existsSync(src)) {
        await execAsync(`cp -r "${src}" "${dst}"`);
      }
    }

    // Backup server.properties
    const propsSrc = path.join(serverPath, 'server.properties');
    if (fs.existsSync(propsSrc)) {
      fs.copyFileSync(propsSrc, path.join(backupPath, 'server.properties'));
    }
  }

  async restoreServerData(serverPath, backupPath) {
    if (!fs.existsSync(backupPath)) return;
    
    const dirsToRestore = ['behavior_packs', 'texture_packs', 'resource_packs', 'worlds', 'user_data'];
    
    for (const dir of dirsToRestore) {
      const src = path.join(backupPath, dir);
      const dst = path.join(serverPath, dir);
      if (fs.existsSync(src)) {
        // Remove new empty dir and restore backup
        if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true });
        fs.renameSync(src, dst);
      }
    }

    // Restore server.properties if it exists
    const propsSrc = path.join(backupPath, 'server.properties');
    if (fs.existsSync(propsSrc)) {
      fs.copyFileSync(propsSrc, path.join(serverPath, 'server.properties'));
    }

    // Cleanup backup
    fs.rmSync(backupPath, { recursive: true, force: true });
  }

  async checkForUpdates() {
    // Check Minecraft for latest version
    try {
      const { stdout } = await execAsync(
        'curl -s https://www.minecraft.net/download/server/bedrock/ | grep -oP \'(?<=version ")[^"]+\' | head -1',
        { timeout: 10000 }
      );
      return { latestVersion: stdout.trim() || 'latest' };
    } catch {
      return { latestVersion: 'latest' };
    }
  }

  // ========== PLAYER MANAGEMENT ==========

  async getOnlinePlayers(serverId) {
    const server = this.getServer(serverId);
    if (!server) return [];
    if (server.status !== 'running') return [];

    try {
      // Send list command and capture output
      const pty = this.ptySessions.get(this.sessionKey(serverId));
      if (!pty) return [];

      // Read current players from database
      const players = db.prepare(`
        SELECT p.*, sp.joined_at 
        FROM players p
        JOIN server_players sp ON p.id = sp.player_id
        WHERE sp.server_id = ? AND sp.is_online = 1
      `).all(serverId);

      return players;
    } catch (err) {
      logger.error(`Error getting online players: ${err.message}`);
      return [];
    }
  }

  async scanPlayers(serverId) {
    const server = this.getServer(serverId);
    if (!server) throw new Error('Server not found');

    try {
      // Try to get player list from server command
      const pty = this.ptySessions.get(this.sessionKey(serverId));
      if (!pty) {
        return { scanned: 0, message: 'Server not running, cannot scan players' };
      }

      // Read user_data to find known players
      const userDataPath = path.join(server.data_path, 'user_data');
      const discovered = [];

      if (fs.existsSync(userDataPath)) {
        const files = fs.readdirSync(userDataPath);
        for (const file of files) {
          const filePath = path.join(userDataPath, file);
          if (fs.statSync(filePath).isFile()) {
            try {
              const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (content.name || content.xuid) {
                discovered.push({
                  username: content.name || file,
                  xuid: content.xuid || null
                });
              }
            } catch { /* skip invalid files */ }
          }
        }
      }

      // Add to database
      let added = 0;
      for (const player of discovered) {
        try {
          const insert = db.prepare(`
            INSERT OR IGNORE INTO players (username, xuid) VALUES (?, ?)
          `).run(player.username, player.xuid);
          if (insert.changes > 0) added++;
        } catch { /* duplicate */ }
      }

      logger.info(`Scanned ${discovered.length} players, added ${added} new`);
      return { scanned: discovered.length, added };
    } catch (err) {
      logger.error(`Player scan failed: ${err.message}`);
      return { scanned: 0, error: err.message };
    }
  }

  async addToWhitelist(serverId, playerId) {
    return this.updatePlayerAccess(serverId, playerId, { isWhitelisted: true, isBanned: false });
  }

  async removeFromWhitelist(serverId, playerId) {
    return this.updatePlayerAccess(serverId, playerId, { isWhitelisted: false });
  }

  getPlayerAccess(serverId) {
    if (!this.getServer(serverId)) throw new Error('Server not found');
    return db.prepare(`
      SELECT p.*, COALESCE(a.is_whitelisted, 0) AS is_whitelisted,
        COALESCE(a.permission, 'member') AS permission,
        COALESCE(a.is_banned, 0) AS is_banned, a.ban_reason
      FROM players p
      LEFT JOIN server_player_access a
        ON a.player_id = p.id AND a.server_id = ?
      ORDER BY p.username COLLATE NOCASE
    `).all(serverId);
  }

  updatePlayerAccess(serverId, playerId, changes = {}) {
    const server = this.getServer(serverId);
    const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
    if (!server) throw new Error('Server not found');
    if (this.isBedrockConnect(server)) {
      throw new Error('Bedrock Connect does not support player access changes');
    }
    if (!player) throw new Error('Player not found');

    const current = db.prepare(`
      SELECT * FROM server_player_access WHERE server_id = ? AND player_id = ?
    `).get(serverId, playerId) || {
      is_whitelisted: 0,
      permission: 'member',
      is_banned: 0,
      ban_reason: null,
    };

    const permission = changes.permission ?? current.permission;
    if (!['visitor', 'member', 'operator'].includes(permission)) {
      throw new Error('Permission must be visitor, member, or operator');
    }

    let isWhitelisted = changes.isWhitelisted === undefined
      ? current.is_whitelisted
      : Number(Boolean(changes.isWhitelisted));
    const isBanned = changes.isBanned === undefined
      ? current.is_banned
      : Number(Boolean(changes.isBanned));
    if (isBanned) isWhitelisted = 0;
    const banReason = isBanned ? (changes.banReason ?? current.ban_reason ?? 'Banned by server administrator') : null;

    db.prepare(`
      INSERT INTO server_player_access
        (server_id, player_id, is_whitelisted, permission, is_banned, ban_reason)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id, player_id) DO UPDATE SET
        is_whitelisted = excluded.is_whitelisted,
        permission = excluded.permission,
        is_banned = excluded.is_banned,
        ban_reason = excluded.ban_reason,
        updated_at = CURRENT_TIMESTAMP
    `).run(serverId, playerId, isWhitelisted, permission, isBanned, banReason);

    this.syncPlayerAccessFiles(serverId);
    this.syncGlobalWhitelistFlag(playerId);

    if (server.status === 'running') {
      const safeName = this.quoteCommandArgument(player.username);
      if (changes.isWhitelisted !== undefined || changes.isBanned) {
        this.sendCommand(serverId, `allowlist ${isWhitelisted ? 'add' : 'remove'} ${safeName}`);
      }
      if (changes.permission !== undefined) {
        this.sendCommand(serverId, `permission set ${safeName} ${permission}`);
      }
      if (isBanned) {
        this.sendCommand(serverId, `kick ${safeName} ${this.quoteCommandArgument(banReason)}`);
      }
    }

    return db.prepare(`
      SELECT p.*, a.is_whitelisted, a.permission, a.is_banned, a.ban_reason
      FROM players p JOIN server_player_access a ON a.player_id = p.id
      WHERE a.server_id = ? AND p.id = ?
    `).get(serverId, playerId);
  }

  syncGlobalWhitelistFlag(playerId) {
    const any = db.prepare(`
      SELECT 1 FROM server_player_access
      WHERE player_id = ? AND is_whitelisted = 1 LIMIT 1
    `).get(playerId);
    db.prepare('UPDATE players SET is_whitelisted = ? WHERE id = ?').run(any ? 1 : 0, playerId);
  }

  syncPlayerAccessFiles(serverId) {
    const server = this.getServer(serverId);
    if (!server) throw new Error('Server not found');
    const rows = db.prepare(`
      SELECT p.username, p.xuid, a.is_whitelisted, a.permission
      FROM server_player_access a JOIN players p ON p.id = a.player_id
      WHERE a.server_id = ? AND a.is_banned = 0
      ORDER BY p.username COLLATE NOCASE
    `).all(serverId);

    const allowlist = rows.filter(row => row.is_whitelisted).map(row => {
      const entry = { ignoresPlayerLimit: false, name: row.username };
      if (row.xuid) entry.xuid = String(row.xuid);
      return entry;
    });
    const permissions = rows.filter(row => row.xuid).map(row => ({
      permission: row.permission,
      xuid: String(row.xuid),
    }));

    fs.writeFileSync(path.join(server.data_path, 'allowlist.json'), `${JSON.stringify(allowlist, null, 2)}\n`);
    fs.writeFileSync(path.join(server.data_path, 'permissions.json'), `${JSON.stringify(permissions, null, 2)}\n`);
  }

  quoteCommandArgument(value) {
    return `"${String(value ?? '').replace(/["\\\r\n]/g, '')}"`;
  }

  enforceBansFromOutput(serverId, data) {
    const text = String(data);
    const patterns = [
      /Player connected:\s*([^,\r\n]+)(?:,\s*xuid:\s*(\d+))?/gi,
    ];
    const seen = new Set();
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const username = match[1].trim();
        if (!username || seen.has(username.toLowerCase())) continue;
        seen.add(username.toLowerCase());
        if (match[2]) {
          const updated = db.prepare('UPDATE players SET xuid = COALESCE(xuid, ?) WHERE username = ? COLLATE NOCASE')
            .run(match[2], username);
          if (updated.changes) this.syncPlayerAccessFiles(serverId);
        }
        const banned = db.prepare(`
          SELECT a.ban_reason FROM server_player_access a
          JOIN players p ON p.id = a.player_id
          WHERE a.server_id = ? AND a.is_banned = 1 AND p.username = ? COLLATE NOCASE
        `).get(serverId, username);
        const sessionKey = this.sessionKey(serverId);
        if (banned && this.ptySessions.has(sessionKey)) {
          const reason = banned.ban_reason || 'Banned by server administrator';
          this.ptySessions.get(sessionKey).write(`kick ${this.quoteCommandArgument(username)} ${this.quoteCommandArgument(reason)}\n`);
        }
      }
    }
  }

  // ========== PORT MANAGEMENT ==========

  isUdpPortAvailable(port) {
    return new Promise((resolve) => {
      const socket = dgram.createSocket('udp4');
      let settled = false;
      const finish = (available) => {
        if (settled) return;
        settled = true;
        try { socket.close(); } catch { /* socket was never bound */ }
        resolve(available);
      };

      socket.once('error', () => finish(false));
      socket.bind(port, '0.0.0.0', () => finish(true));
    });
  }

  registerPort(serverId, port, protocol = 'udp') {
    db.prepare(`
      INSERT OR REPLACE INTO port_usage (port, server_id, protocol, in_use)
      VALUES (?, ?, ?, 1)
    `).run(port, serverId, protocol);
  }

  unregisterPorts(serverId) {
    db.prepare('DELETE FROM port_usage WHERE server_id = ?').run(serverId);
  }

  async getAllPorts() {
    // Get ports 1-65535 conceptually, but we'll track commonly used ranges
    // Return known used ports and OS-level available ports in common ranges.
    const usedPorts = db.prepare(`
      SELECT p.port, p.protocol, p.in_use, s.name as server_name
      FROM port_usage p
      LEFT JOIN servers s ON p.server_id = s.id
      ORDER BY p.port
    `).all();

    const usedPortSet = new Set(usedPorts.map(p => p.port));
    const pendingRows = db.prepare(`
      SELECT pending_port AS port, name AS server_name
      FROM servers
      WHERE pending_port IS NOT NULL
    `).all();
    for (const row of pendingRows) {
      if (usedPortSet.has(row.port)) continue;
      usedPortSet.add(row.port);
      usedPorts.push({
        port: row.port,
        protocol: 'udp',
        in_use: 1,
        server_name: `${row.server_name} (pending)`,
      });
    }
    if ((this.getBedrockConnectServer() || this.getPendingBedrockConnect()) && !usedPortSet.has(BEDROCK_CONNECT_PORT)) {
      usedPortSet.add(BEDROCK_CONNECT_PORT);
      usedPorts.push({
        port: BEDROCK_CONNECT_PORT,
        protocol: 'udp',
        in_use: 1,
        server_name: 'Bedrock Connect',
      });
    }
    const lanBroadcast = require('./lanBroadcast');
    for (const port of lanBroadcast.usedProxyPorts()) {
      if (usedPortSet.has(port)) continue;
      usedPortSet.add(port);
      usedPorts.push({ port, protocol: 'udp', in_use: 1, server_name: 'LAN proxy' });
    }
    const proxyRows = db.prepare(`
      SELECT lan_proxy_port AS port, name AS server_name
      FROM servers
      WHERE lan_proxy_port IS NOT NULL
    `).all();
    for (const row of proxyRows) {
      if (usedPortSet.has(row.port)) continue;
      usedPortSet.add(row.port);
      usedPorts.push({
        port: row.port,
        protocol: 'udp',
        in_use: 1,
        server_name: `${row.server_name} (LAN proxy)`,
      });
    }
    if (lanBroadcast.hasAnyActive() && !usedPortSet.has(lanBroadcast.DISCOVERY_PORT) && !this.getBedrockConnectServer()) {
      usedPortSet.add(lanBroadcast.DISCOVERY_PORT);
      usedPorts.push({
        port: lanBroadcast.DISCOVERY_PORT,
        protocol: 'udp',
        in_use: 1,
        server_name: 'Console LAN discovery',
      });
    }
    for (let port = lanBroadcast.PROXY_PORT_START; port <= lanBroadcast.PROXY_PORT_END; port += 1) {
      usedPortSet.add(port);
    }

    // Generate available ports (common Minecraft ranges)
    const candidatePorts = [];
    
    // Check ranges: 1-1024 (system), 1025-49151 (registered), 49152-65535 (dynamic)
    for (let port = 19132; port <= 19199; port++) {
      if (!usedPortSet.has(port)) {
        candidatePorts.push(port);
      }
    }
    for (let port = 25565; port <= 25665; port++) {
      if (!usedPortSet.has(port)) {
        candidatePorts.push(port);
      }
    }
    for (let port = 30000; port <= 30100; port++) {
      if (!usedPortSet.has(port)) {
        candidatePorts.push(port);
      }
    }

    const availability = await Promise.all(
      candidatePorts.map(async port => ({
        port,
        available: await this.isUdpPortAvailable(port),
      }))
    );
    const availablePorts = availability
      .filter(result => result.available)
      .map(({ port }) => ({ port, protocol: 'udp', in_use: 0, server_name: null }));

    return { used: usedPorts, available: availablePorts };
  }

  // ========== DATA ACCESS ==========

  getServer(serverId) {
    return db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
  }

  getAllServers() {
    return db.prepare(`
      SELECT * FROM servers
      ORDER BY CASE WHEN kind = 'bedrock_connect' THEN 0 ELSE 1 END, name COLLATE NOCASE
    `).all();
  }

  async getServerStats(serverId) {
    const server = this.getServer(serverId);
    if (!server) return null;

    const onlinePlayers = db.prepare(`
      SELECT COUNT(*) as count FROM server_players 
      WHERE server_id = ? AND is_online = 1
    `).get(serverId);

    const installedMods = db.prepare(`
      SELECT COUNT(*) as count FROM server_mods WHERE server_id = ?
    `).get(serverId);

    const uptime = server.started_at 
      ? this.calculateUptime(server.started_at) 
      : '0m';

    return this.attachLanStatus({
      ...server,
      onlinePlayers: onlinePlayers?.count || 0,
      installedMods: installedMods?.count || 0,
      uptime
    });
  }

  calculateUptime(startTime) {
    const start = new Date(startTime);
    const now = new Date();
    const diff = now - start;
    
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    
    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  async detectArchitecture() {
    try {
      const { stdout } = await execAsync('uname -m');
      return stdout.trim();
    } catch {
      return 'x86_64';
    }
  }

  // ========== PTY OUTPUT BROADCAST ==========

  setupPtyOutputBroadcast(serverId, pty) {
    // Remove any existing listener to prevent duplicates
    const existing = pty.listeners('data');
    existing.forEach(listener => pty.removeListener('data', listener));

    pty.on('data', (data) => {
      this.enforceBansFromOutput(serverId, data);
      if (global.io) {
        global.io.to(`server-${serverId}`).emit('server-output', {
          serverId,
          data
        });
      }
    });

    pty.on('exit', () => {
      const sessionKey = this.sessionKey(serverId);
      if (this.ptySessions.get(sessionKey) !== pty) return;
      this.ptySessions.delete(sessionKey);
      this.markServerStopped(serverId);
      logger.info(`Server process for ${serverId} exited; status changed to stopped`);
    });
  }

  // ========== BROADCAST ==========

  broadcastServerStatus(serverId) {
    // This will be connected to Socket.IO in the main server
    if (global.io) {
      const server = this.getServer(serverId);
      if (server) {
        global.io.emit('server-status', {
          serverId,
          name: server.name,
          status: server.status,
          uptime: server.started_at ? this.calculateUptime(server.started_at) : '0m'
        });
      }
    }
  }

  // Cleanup on shutdown
  shutdown() {
    for (const { timers } of this.scheduledRestarts.values()) {
      timers.forEach(timer => clearTimeout(timer));
    }
    this.scheduledRestarts.clear();
    for (const [id, pty] of this.ptySessions) {
      try { pty.kill(); } catch {}
    }
    this.ptySessions.clear();
    this.servers.clear();
    try { require('./lanBroadcast').stopAll(); } catch { /* ignore */ }
  }
}

module.exports = new ServerManager();
