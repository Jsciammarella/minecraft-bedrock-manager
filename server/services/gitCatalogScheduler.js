const logger = require('./logger');
const gitCatalog = require('./gitCatalogClient');

function intervalMs() {
  const hours = Number.parseInt(process.env.GIT_CATALOG_SYNC_HOURS, 10);
  const resolved = Number.isFinite(hours) && hours > 0 ? hours : 2;
  return resolved * 60 * 60 * 1000;
}

class GitCatalogScheduler {
  constructor() {
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const ms = intervalMs();
    logger.info(`Git catalog scheduler started (interval: ${ms / 3600000}h)`);
    this.syncSafe('startup');
    this.timer = setInterval(() => this.syncSafe('scheduled'), ms);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
  }

  async syncSafe(reason) {
    if (!gitCatalog.isConfigured()) return;
    try {
      const result = await gitCatalog.sync();
      logger.info(`Git catalog ${reason} sync complete (${result.modCount} mods)`);
    } catch (err) {
      logger.warn(`Git catalog ${reason} sync failed: ${err.message}`);
    }
  }
}

module.exports = new GitCatalogScheduler();
