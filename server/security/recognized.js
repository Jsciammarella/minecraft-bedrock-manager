const logger = require('../services/logger');
const catalog = require('../services/permissionCatalog');

const SPECIAL_ACTIONS = new Set([
  'admin',
  'gateway:lifecycle',
]);

function isPluginAction(action) {
  const key = String(action || '');
  return key.startsWith('plugin.') || key.startsWith('menu.view.plugin.');
}

function isRecognized(action) {
  const key = String(action || '');
  if (!key) return false;
  if (SPECIAL_ACTIONS.has(key)) return true;
  return Boolean(catalog.permissionByKey(key) || catalog.ALL_KEYS.includes(key));
}

function denyUnknown(action, profile) {
  logger.warn(`Unknown permission "${action}" denied (${profile})`);
  return false;
}

function catalogKeys() {
  return catalog.listKeys ? catalog.listKeys() : [...catalog.ALL_KEYS];
}

module.exports = {
  SPECIAL_ACTIONS,
  isPluginAction,
  isRecognized,
  denyUnknown,
  catalogKeys,
};
