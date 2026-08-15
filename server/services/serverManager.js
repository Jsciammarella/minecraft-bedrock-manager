const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const db = require('../db/connection');
const logger = require('./logger');
const execAsync = promisify(exec);

const BASE_DIR = path.join(__dirname, '../../data/servers');
const MODS_DIR = path.join(__dirname, '../../data/mods');

class ServerManager {
  constructor() {
    this.servers = new Map(); // in-memory server state
    this.ptySessions = new Map(); // serverId -> pty session
    this.processes = new Map(); // serverId -> process reference
    this.scheduledRestarts = new Map(); // serverId -> warning/restart timers
    
    // Ensure directories exist
    fs.mkdirSync(BASE_DIR, { recursive: true });
    fs.mkdirSync(MODS_DIR, { recursive: true });

    // A managed Bedrock process cannot survive a manager/container restart because
    // its PTY belongs to this process. Never carry an old "running" state forward.
    const reconciled = db.prepare(`
      UPDATE servers
      SET status = 'stopped', pid = NULL, started_at = NULL, restart_scheduled_at = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE status IN ('running', 'starting')
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
    this.cancelWarnedRestart(serverId, { broadcast: false });
    db.prepare(`
      UPDATE servers
      SET status = 'stopped', pid = NULL, started_at = NULL, restart_scheduled_at = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(serverId);
    this.invalidateServerCache(serverId);
    if (broadcast) this.broadcastServerStatus(serverId);
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

  cancelWarnedRestart(serverId, { broadcast = true } = {}) {
    const key = this.sessionKey(serverId);
    const scheduled = this.scheduledRestarts.get(key);
    if (scheduled) {
      scheduled.timers.forEach(timer => clearTimeout(timer));
      this.scheduledRestarts.delete(key);
    }
    db.prepare('UPDATE servers SET restart_scheduled_at = NULL WHERE id = ?').run(serverId);
    this.invalidateServerCache(serverId);
    if (broadcast) this.broadcastServerStatus(serverId);
    return { success: true };
  }

  // ========== SERVER LIFECYCLE ==========

  async createServer(config) {
    const { name, port, version, maxPlayers, description, gamemode, difficulty } = config;

    // Validate port
    if (port < 1 || port > 65535) {
      throw new Error('Port must be between 1 and 65535');
    }

    // Check port availability
    const existing = db.prepare('SELECT * FROM servers WHERE port = ? OR name = ?').get(port, name);
    if (existing) {
      throw new Error('Port or server name already in use');
    }

    // Download and extract the server
    const serverPath = path.join(BASE_DIR, name);
    fs.mkdirSync(serverPath, { recursive: true });

    // Download Minecraft Bedrock server
    await this.downloadServer(serverPath, version || 'latest');

    // Create server directory structure
    fs.mkdirSync(path.join(serverPath, 'behavior_packs'), { recursive: true });
    fs.mkdirSync(path.join(serverPath, 'texture_packs'), { recursive: true });
    fs.mkdirSync(path.join(serverPath, 'worlds'), { recursive: true });
    fs.mkdirSync(path.join(serverPath, 'resource_packs'), { recursive: true });

    // Create initial server.properties
    const props = {
      'level-name': name,
      'server-port': String(port),
      'server-portv6': String(port),
      'max-players': String(maxPlayers || 10),
      'allow-list': 'false',
      difficulty: difficulty || 'peaceful',
      gamemode: gamemode || 'survival',
      'default-player-permission': 'member',
      'server-authoritative': 'true',
      'enable-cheats': 'true',
      'server-description': description || 'Minecraft Bedrock Server',
      'texturepack-name': '',
      'texturepacks-required': 'false',
      'content-log-file-enable': 'false',
      'compression-threshold-kb': '1',
    };

    this.writeServerProperties(path.join(serverPath, 'server.properties'), props);
    fs.writeFileSync(path.join(serverPath, 'allowlist.json'), '[]\n');
    fs.writeFileSync(path.join(serverPath, 'permissions.json'), '[]\n');

    // Insert into database
    const insert = db.prepare(`
      INSERT INTO servers (name, version, port, max_players, whitelist_mode, difficulty, gamemode, 
        server_description, server_motd, status, data_path)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, 'stopped', ?)
    `);
    const result = insert.run(
      name, version || 'latest', port, maxPlayers || 10, 
      difficulty || 'peaceful', gamemode || 'survival',
      description || 'Minecraft Bedrock Server',
      description || 'Minecraft Bedrock Server',
      serverPath
    );

    const serverId = result.lastInsertRowid;

    // Register port
    this.registerPort(serverId, port, 'udp');
    this.registerPort(serverId, port, 'tcp');

    logger.info(`Created server: ${name} on port ${port}`);
    return { id: serverId, name, port, dataPath: serverPath };
  }

  async downloadServer(targetDir, version) {
    const arch = await this.detectArchitecture();
    const url = version === 'latest'
      ? 'https://minecraft.net/bedrock-installers'
      : `https://minecraft.net/bedrock-installers?version=${version}`;

    logger.info(`Downloading Minecraft Bedrock server to ${targetDir}`);

    // Try to download the official server
    try {
      const downloadUrl = `https://www.minecraft.net/download/server/bedrock/`;
      
      // Use wget/curl to download
      const downloadPath = path.join(targetDir, 'bedrock_server.tgz');
      const { stdout } = await execAsync(
        `wget -q -O "${downloadPath}" "https://www.minecraft.net/bedrock-server/" 2>/dev/null || true`,
        { timeout: 120000 }
      );

      // If direct download fails, try alternative method
      if (!fs.existsSync(downloadPath) || fs.statSync(downloadPath).size < 1000) {
        throw new Error('Download failed or file too small');
      }

      // Extract
      await execAsync(`tar -xzf "${downloadPath}" -C "${targetDir}"`, { timeout: 120000 });
      fs.unlinkSync(downloadPath);
    } catch (err) {
      logger.warn(`Direct download failed: ${err.message}. Creating stub server files.`);
      // Create stub files so the manager can still work
      await this.createStubServer(targetDir);
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

  async startServer(serverId) {
    const sessionKey = this.sessionKey(serverId);
    const server = this.getServer(serverId);
    if (!server) throw new Error('Server not found');
    if (server.status === 'running') throw new Error('Server already running');

    const serverPath = server.data_path;
    const serverBin = path.join(serverPath, 'bedrock_server');

    // Check if binary exists
    if (!fs.existsSync(serverBin)) {
      throw new Error(`Server binary not found at ${serverBin}. Please install the server first.`);
    }

    try {
      // Make executable
      fs.chmodSync(serverBin, '755');

      // Start the server process with PTY for terminal access
      const { spawn: spawnPty } = require('node-pty');
      const pty = spawnPty('bash', [
        '-c', 
        `cd "${serverPath}" && PORT=${server.port} ./bedrock_server`
      ], {
        name: 'xterm-color',
        cols: 120,
        rows: 30,
        cwd: serverPath,
        env: { ...process.env, PORT: String(server.port) }
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
    if (server.status === 'stopped') throw new Error('Server already stopped');

    const pty = this.ptySessions.get(sessionKey);
    if (pty) {
      // Send stop command
      pty.write('stop\n');
      
      // Wait for shutdown
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

      this.ptySessions.delete(sessionKey);
    }

    db.prepare('UPDATE servers SET status = ?, pid = NULL, started_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run('stopped', serverId);
    // Invalidate cache so next getServer() reads fresh status
    this.invalidateServerCache(serverId);

    logger.info(`Server ${server.name} stopped`);
    this.broadcastServerStatus(serverId);
    return { success: true, message: 'Server stopped' };
  }

  async restartServer(serverId) {
    await this.stopServer(serverId);
    await this.startServer(serverId);
  }

  scheduleWarnedRestart(serverId) {
    const key = this.sessionKey(serverId);
    const server = this.getServer(serverId);
    if (!server) throw new Error('Server not found');
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

    // Stop if running
    if (server.status !== 'stopped') {
      await this.stopServer(serverId);
    }

    // Remove data directory
    const serverPath = server.data_path;
    if (fs.existsSync(serverPath)) {
      fs.rmSync(serverPath, { recursive: true, force: true });
    }

    // Unregister ports
    this.unregisterPorts(serverId);

    // Remove from database
    db.prepare('DELETE FROM servers WHERE id = ?').run(serverId);
    
    this.invalidateServerCache(serverId);
    logger.info(`Deleted server: ${server.name}`);
    return { success: true, message: 'Server deleted' };
  }

  // ========== SERVER COMMANDS ==========

  sendCommand(serverId, command) {
    const pty = this.ptySessions.get(this.sessionKey(serverId));
    if (!pty) {
      this.markServerStopped(serverId);
      throw new Error('Server process is not running. Its status has been corrected to Offline.');
    }
    pty.write(`${command}\n`);
    return { success: true, command };
  }

  // ========== SERVER PROPERTIES ==========

  updateSettings(serverId, settings) {
    const server = this.getServer(serverId);
    if (!server) throw new Error('Server not found');

    const propsPath = path.join(server.data_path, 'server.properties');
    const currentProps = this.readServerProperties(propsPath);
    
    // Map settings to properties
    const mapping = {
      max_players: 'max-players',
      difficulty: 'difficulty',
      gamemode: 'gamemode',
      whitelist_mode: 'allow-list',
      server_description: 'server-description',
      server_motd: 'server-description',
      texture_pack_required: 'texturepacks-required',
      enable_cheats: 'enable-cheats',
      server_authoritative: 'server-authoritative',
      default_1st_person: 'default-player-permission',
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
      default_player_permission: 'default-player-permission',
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
    for (const [key, value] of Object.entries(settings)) {
      const propKey = mapping[key] || key;
      if (propKey) {
        currentProps[propKey] = booleanSettings.has(key)
          ? String(value === true || value === 1 || value === '1' || value === 'true')
          : String(value);
      }
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
      settings.max_players ?? null,
      settings.difficulty ?? null,
      settings.gamemode ?? null,
      toSqliteBoolean(settings.whitelist_mode),
      settings.server_description ?? null,
      settings.server_motd ?? null,
      toSqliteBoolean(settings.texture_pack_required),
      toSqliteBoolean(settings.enable_cheats),
      toSqliteBoolean(settings.server_authoritative),
      toSqliteBoolean(settings.default_1st_person),
      serverId
    );

    logger.info(`Updated settings for server ${server.name}`);
    
    // Invalidate cache so next getServer() reads fresh data from DB
    this.invalidateServerCache(serverId);
    if (server.status === 'running' && Object.keys(settings).length > 0) {
      this.markRestartRequired(serverId, 'Server settings changed');
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
    const allPorts = [];
    
    // Get ports 1-65535 conceptually, but we'll track commonly used ranges
    // Return known used ports and available ports in common ranges
    const usedPorts = db.prepare(`
      SELECT p.port, p.protocol, p.in_use, s.name as server_name
      FROM port_usage p
      LEFT JOIN servers s ON p.server_id = s.id
      ORDER BY p.port
    `).all();

    // Generate available ports (common Minecraft ranges)
    const usedPortSet = new Set(usedPorts.map(p => p.port));
    const availablePorts = [];
    
    // Check ranges: 1-1024 (system), 1025-49151 (registered), 49152-65535 (dynamic)
    for (let port = 19132; port <= 19199; port++) {
      if (!usedPortSet.has(port)) {
        availablePorts.push({ port, protocol: 'udp', in_use: 0, server_name: null });
      }
    }
    for (let port = 25565; port <= 25665; port++) {
      if (!usedPortSet.has(port)) {
        availablePorts.push({ port, protocol: 'udp', in_use: 0, server_name: null });
      }
    }
    for (let port = 30000; port <= 30100; port++) {
      if (!usedPortSet.has(port)) {
        availablePorts.push({ port, protocol: 'udp', in_use: 0, server_name: null });
      }
    }

    return { used: usedPorts, available: availablePorts };
  }

  // ========== DATA ACCESS ==========

  getServer(serverId) {
    const key = this.sessionKey(serverId);
    if (this.servers.has(key)) return this.servers.get(key);
    
    const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
    if (row) {
      this.servers.set(key, row);
    }
    return row;
  }

  getAllServers() {
    const rows = db.prepare('SELECT * FROM servers ORDER BY name').all();
    rows.forEach(r => this.servers.set(this.sessionKey(r.id), r));
    return rows;
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

    return {
      ...server,
      onlinePlayers: onlinePlayers?.count || 0,
      installedMods: installedMods?.count || 0,
      uptime
    };
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
  }
}

module.exports = new ServerManager();
