const settingsStore = require('./settingsStore');
const pluginAudit = require('./pluginAudit');

const MIGRATED = 'catalog_curseforge_sources_migrated';

function flag(key, fallback = true) {
  const stored = settingsStore.get(key);
  if (stored) return settingsStore.isTruthy(stored);
  return fallback;
}

function migrateCurseForge() {
  if (settingsStore.get(MIGRATED)) return getCurseForgeSources();
  let javaEnabled = true;
  try {
    const host = require('./pluginHost');
    const state = host.readPluginState ? host.readPluginState() : { enabled: {} };
    if (Object.prototype.hasOwnProperty.call(state.enabled || {}, 'catalog-curseforge-java')) {
      javaEnabled = Boolean(state.enabled['catalog-curseforge-java']);
    }
  } catch {
    javaEnabled = true;
  }
  if (!settingsStore.get(settingsStore.KEYS.CF_BEDROCK_ENABLED)) {
    settingsStore.set(settingsStore.KEYS.CF_BEDROCK_ENABLED, '1');
  }
  if (!settingsStore.get(settingsStore.KEYS.CF_JAVA_ENABLED)) {
    settingsStore.set(settingsStore.KEYS.CF_JAVA_ENABLED, javaEnabled ? '1' : '0');
  }
  settingsStore.set(MIGRATED, '1');
  pluginAudit.record('catalog.curseforge.migrated', {
    targetType: 'plugin',
    targetId: 'catalog-curseforge',
    detail: { bedrockEnabled: true, javaEnabled },
  });
  return getCurseForgeSources();
}

function getCurseForgeSources() {
  return {
    bedrockEnabled: flag(settingsStore.KEYS.CF_BEDROCK_ENABLED, true),
    javaEnabled: flag(settingsStore.KEYS.CF_JAVA_ENABLED, true),
    migrated: Boolean(settingsStore.get(MIGRATED)),
  };
}

function setCurseForgeSources({ bedrockEnabled, javaEnabled } = {}, { actor = 'local' } = {}) {
  const previous = getCurseForgeSources();
  if (typeof bedrockEnabled === 'boolean') {
    settingsStore.set(settingsStore.KEYS.CF_BEDROCK_ENABLED, bedrockEnabled ? '1' : '0');
    if (previous.bedrockEnabled !== bedrockEnabled) {
      pluginAudit.record(bedrockEnabled ? 'catalog.curseforge.bedrock.enabled' : 'catalog.curseforge.bedrock.disabled', {
        actor,
        targetType: 'catalog-source',
        targetId: 'curseforge-bedrock',
      });
    }
  }
  if (typeof javaEnabled === 'boolean') {
    settingsStore.set(settingsStore.KEYS.CF_JAVA_ENABLED, javaEnabled ? '1' : '0');
    if (previous.javaEnabled !== javaEnabled) {
      pluginAudit.record(javaEnabled ? 'catalog.curseforge.java.enabled' : 'catalog.curseforge.java.disabled', {
        actor,
        targetType: 'catalog-source',
        targetId: 'curseforge-java',
      });
    }
  }
  return getCurseForgeSources();
}

module.exports = {
  getCurseForgeSources,
  migrateCurseForge,
  setCurseForgeSources,
};
