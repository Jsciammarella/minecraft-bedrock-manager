const db = require('../db/connection');
const logger = require('./logger');
const serverManager = require('./serverManager');

class AutoUpdateScheduler {
  constructor() {
    this.timer = null;
    this.checkInterval = parseInt(process.env.AUTO_UPDATE_CHECK_INTERVAL) || 86400; // seconds
    this.running = false;
  }

  /**
   * Start the auto-update check scheduler
   */
  start() {
    if (this.running) {
      logger.warn('Auto-update scheduler already running');
      return;
    }

    this.running = true;
    const intervalMs = this.checkInterval * 1000;

    logger.info(`Auto-update scheduler started (interval: ${this.checkInterval}s)`);

    // Run first check immediately
    this.runScheduledCheck();

    // Schedule recurring checks
    this.timer = setInterval(() => {
      this.runScheduledCheck();
    }, intervalMs);

    // Make timer non-blocking
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  /**
   * Stop the scheduler
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    logger.info('Auto-update scheduler stopped');
  }

  /**
   * Run a scheduled update check for all servers with auto-update enabled
   */
  async runScheduledCheck() {
    try {
      logger.info('Running scheduled auto-update check...');

      try {
        const bedrockConnect = require('./bedrockConnect');
        const synced = await bedrockConnect.syncLatest({ download: true });
        logger.info(`Bedrock Connect JAR repository synced (latest ${synced.latestTag})`);
      } catch (err) {
        logger.warn(`Bedrock Connect JAR sync failed: ${err.message}`);
      }

      try {
        const lanBroadcast = require('./lanBroadcast');
        const phantom = await lanBroadcast.checkForUpdates({ download: true });
        if (phantom.updated) {
          logger.info(`Phantom updated to ${phantom.currentTag}`);
        } else if (phantom.latestTag) {
          logger.info(`Phantom is current (${phantom.currentTag})`);
        }
      } catch (err) {
        logger.warn(`Phantom update check failed: ${err.message}`);
      }

      // Get all servers with auto-update enabled
      const servers = db.prepare(`
        SELECT s.*, au.enabled, au.check_interval_hours, au.last_check
        FROM servers s
        JOIN auto_updates au ON s.id = au.server_id
        WHERE au.enabled = 1
      `).all();

      if (servers.length === 0) {
        logger.info('No servers configured for auto-update');
        return;
      }

      // Check for latest version
      const updateInfo = await serverManager.checkForUpdates();
      const latestVersion = updateInfo?.latestVersion || 'latest';
      const bedrockConnect = require('./bedrockConnect');
      const latestConnect = bedrockConnect.latestStoredVersion();

      let updated = 0;
      let skipped = 0;
      let errors = 0;

      for (const server of servers) {
        try {
          if (server.kind === 'bedrock_connect') {
            if (!latestConnect) {
              skipped++;
              this.updateLastCheck(server.id);
              continue;
            }
            if (server.version === latestConnect.tag) {
              logger.info(`Bedrock Connect already on ${server.version}`);
              skipped++;
              this.updateLastCheck(server.id);
              continue;
            }
            if (server.status === 'running' || server.status === 'starting') {
              logger.info('Bedrock Connect is running, skipping auto-update');
              skipped++;
              this.updateLastCheck(server.id);
              continue;
            }
            logger.info(`Auto-updating Bedrock Connect from ${server.version} to ${latestConnect.tag}`);
            await serverManager.updateServer(server.id, latestConnect.tag);
            updated++;
            this.updateLastCheck(server.id);
            if (global.io) {
              global.io.emit('server-updated', {
                serverId: server.id,
                name: server.name,
                fromVersion: server.version,
                toVersion: latestConnect.tag,
              });
            }
            continue;
          }

          // Skip if already on latest version
          if (server.version === latestVersion) {
            logger.info(`Server ${server.name} already on latest version (${server.version})`);
            skipped++;
            this.updateLastCheck(server.id);
            continue;
          }

          // Skip if server is running (don't auto-update running servers)
          if (server.status === 'running') {
            logger.info(`Server ${server.name} is running, skipping auto-update`);
            skipped++;
            this.updateLastCheck(server.id);
            continue;
          }

          // Perform the update
          logger.info(`Auto-updating server ${server.name} from ${server.version} to ${latestVersion}`);
          await serverManager.updateServer(server.id, latestVersion);
          updated++;
          this.updateLastCheck(server.id);

          // Broadcast update via Socket.IO
          if (global.io) {
            global.io.emit('server-updated', {
              serverId: server.id,
              name: server.name,
              fromVersion: server.version,
              toVersion: latestVersion
            });
          }
        } catch (err) {
          logger.error(`Auto-update failed for ${server.name}: ${err.message}`);
          errors++;
          this.updateLastCheck(server.id);
        }
      }

      logger.info(`Auto-update check complete: ${updated} updated, ${skipped} skipped, ${errors} errors`);
    } catch (err) {
      logger.error(`Scheduled update check failed: ${err.message}`);
    }
  }

  /**
   * Update the last_check timestamp for a server
   */
  updateLastCheck(serverId) {
    try {
      db.prepare(`
        UPDATE auto_updates SET last_check = CURRENT_TIMESTAMP WHERE server_id = ?
      `).run(serverId);
    } catch (err) {
      logger.error(`Failed to update last_check for server ${serverId}: ${err.message}`);
    }
  }

  /**
   * Enable auto-update for a server
   */
  enableAutoUpdate(serverId, intervalHours = 24) {
    try {
      db.prepare(`
        INSERT INTO auto_updates (server_id, enabled, check_interval_hours)
        VALUES (?, 1, ?)
        ON CONFLICT(server_id) DO UPDATE SET enabled = 1, check_interval_hours = ?
      `).run(serverId, intervalHours, intervalHours);
      logger.info(`Auto-update enabled for server ${serverId}`);
      return { success: true };
    } catch (err) {
      logger.error(`Failed to enable auto-update: ${err.message}`);
      throw new Error(`Failed to enable auto-update: ${err.message}`);
    }
  }

  /**
   * Disable auto-update for a server
   */
  disableAutoUpdate(serverId) {
    try {
      db.prepare(`
        UPDATE auto_updates SET enabled = 0 WHERE server_id = ?
      `).run(serverId);
      logger.info(`Auto-update disabled for server ${serverId}`);
      return { success: true };
    } catch (err) {
      logger.error(`Failed to disable auto-update: ${err.message}`);
      throw new Error(`Failed to disable auto-update: ${err.message}`);
    }
  }

  /**
   * Get auto-update config for a server
   */
  getAutoUpdateConfig(serverId) {
    try {
      return db.prepare(`
        SELECT * FROM auto_updates WHERE server_id = ?
      `).get(serverId);
    } catch (err) {
      logger.error(`Failed to get auto-update config: ${err.message}`);
      return null;
    }
  }

  /**
   * Get auto-update configs for all servers
   */
  getAllAutoUpdateConfigs() {
    try {
      return db.prepare(`
        SELECT au.*, s.name as server_name
        FROM auto_updates au
        JOIN servers s ON au.server_id = s.id
        ORDER BY s.name
      `).all();
    } catch (err) {
      logger.error(`Failed to get all auto-update configs: ${err.message}`);
      return [];
    }
  }
}

module.exports = new AutoUpdateScheduler();
