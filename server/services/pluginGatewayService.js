const gatewayManager = require('./gatewayManager');
const gatewayRegistry = require('./gatewayRegistry');
const db = require('../db/connection');

function notFound() {
  return Object.assign(new Error('Gateway not found'), { status: 404 });
}

function unavailable() {
  return Object.assign(new Error('That gateway provider is not available'), { status: 404 });
}

function forbidden(message) {
  return Object.assign(new Error(message), { status: 403 });
}

function ownedProviderIds(pluginId) {
  return gatewayRegistry.entries()
    .filter((entry) => entry.pluginId === pluginId)
    .map((entry) => entry.id);
}

function scopedGatewayService(plugin) {
  const pluginId = plugin.id;

  function providers() {
    return ownedProviderIds(pluginId);
  }

  function assertOwn(id) {
    const row = gatewayManager.get(id);
    if (!row) throw notFound();
    if (!providers().includes(row.provider_id)) throw notFound();
    return row;
  }

  function resolveProviderId(requested) {
    const ids = providers();
    if (!ids.length) throw unavailable();
    const wanted = String(requested || '').trim();
    if (!wanted) return ids[0];
    if (!ids.includes(wanted)) {
      throw forbidden('This plugin cannot manage another gateway provider');
    }
    return wanted;
  }

  return {
    create(config = {}) {
      const providerId = resolveProviderId(config.providerId);
      return gatewayManager.create({ ...config, providerId });
    },
    listOwn() {
      const ids = new Set(providers());
      return gatewayManager.list().filter((row) => ids.has(row.provider_id));
    },
    getOwn(id) {
      assertOwn(id);
      return gatewayManager.status(id);
    },
    updateOwn(id, config = {}) {
      assertOwn(id);
      if (config.providerId && !providers().includes(String(config.providerId))) {
        throw forbidden('This plugin cannot manage another gateway provider');
      }
      const { providerId, ...rest } = config;
      return gatewayManager.patch(id, rest);
    },
    async startOwn(id) {
      assertOwn(id);
      return gatewayManager.start(id);
    },
    stopOwn(id) {
      assertOwn(id);
      return gatewayManager.stop(id);
    },
    async restartOwn(id) {
      assertOwn(id);
      return gatewayManager.restart(id);
    },
    removeOwn(id) {
      assertOwn(id);
      return gatewayManager.remove(id);
    },
    logsOwn(id) {
      assertOwn(id);
      return gatewayManager.logs(id);
    },
    statusOwn(id) {
      assertOwn(id);
      return gatewayManager.status(id);
    },
    checkCompatibilityOwn(id) {
      assertOwn(id);
      return gatewayManager.checkCompatibility(id);
    },
    installCompatibilityOwn(id, body = {}) {
      assertOwn(id);
      return gatewayManager.installCompatibility(id, body);
    },
    removeCompatibilityOwn(id, body = {}) {
      assertOwn(id);
      return gatewayManager.removeCompatibility(id, body);
    },
    listJavaTargets() {
      return db.prepare(`
        SELECT id, name, port, status
        FROM servers
        WHERE kind = 'java'
        ORDER BY name
      `).all();
    },
  };
}

module.exports = {
  ownedProviderIds,
  scopedGatewayService,
};
