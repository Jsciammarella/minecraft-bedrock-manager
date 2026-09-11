'use strict';

const minecraftVersions = require('../../services/minecraftVersions');
const mapping = require('./versionMapping');

const MIGRATION_KEY = 'neoforge_minecraft_version_repair_v1';

function parseMetadata(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function updateMetadata(raw, minecraftVersion, loaderVersion) {
  const meta = parseMetadata(raw);
  const next = {
    ...meta,
    loader: 'neoforge',
    minecraftVersion,
  };
  if (loaderVersion) next.loaderVersion = loaderVersion;
  return JSON.stringify(next);
}

function authoritativeMinecraft(row) {
  const inspected = mapping.inspectInstalledMinecraft(row.data_path, row);
  if (inspected?.minecraftVersion) return inspected;
  const fromLoader = mapping.minecraftFromNeoForge(row.loader_version);
  if (fromLoader) return { minecraftVersion: fromLoader, source: 'loader_version' };
  return null;
}

function decideRepair(row) {
  if (String(row.loader_provider_id || '').toLowerCase() !== 'neoforge') {
    return { action: 'skip' };
  }
  const current = String(row.minecraft_version || row.version || '').trim();
  const found = authoritativeMinecraft(row);
  if (!found?.minecraftVersion) {
    return {
      action: 'warn',
      reason: `NeoForge server ${row.id} (${row.name}) has no verifiable Minecraft version; left unchanged`,
      current,
    };
  }
  const target = found.minecraftVersion;
  const currentCanonical = minecraftVersions.canonicalMinecraftVersion(current);
  const targetCanonical = minecraftVersions.canonicalMinecraftVersion(target);
  if (current && current === target && !minecraftVersions.isFabricatedMinecraftVersion(current)) {
    return { action: 'unchanged', current, target };
  }
  if (!row.loader_version && found.source !== 'loader_metadata' && !String(found.source || '').includes('version.json')) {
    return {
      action: 'warn',
      reason: `NeoForge server ${row.id} (${row.name}) Minecraft ${current || '(empty)'} could not be verified; left unchanged`,
      current,
      target,
    };
  }
  if (current && current !== target) {
    return {
      action: 'repair',
      from: current,
      to: target,
      source: found.source,
      mismatch: currentCanonical !== targetCanonical,
    };
  }
  if (!current) {
    return { action: 'repair', from: current, to: target, source: found.source };
  }
  return { action: 'unchanged', current, target };
}

function applyRow(db, row, decision, logger) {
  if (decision.action === 'warn') {
    logger?.warn?.(decision.reason);
    return decision;
  }
  if (decision.action !== 'repair') return decision;
  const loaderVersion = row.loader_version || parseMetadata(row.loader_metadata).loaderVersion || '';
  db.prepare(`
    UPDATE servers
    SET version = ?, minecraft_version = ?, loader_metadata = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    decision.to,
    decision.to,
    updateMetadata(row.loader_metadata, decision.to, loaderVersion),
    row.id
  );
  db.prepare(`
    UPDATE gateways
    SET target_minecraft_version = ?
    WHERE target_server_id = ?
  `).run(decision.to, row.id);
  if (decision.mismatch) {
    logger?.warn?.(
      `NeoForge server ${row.id} (${row.name}) Minecraft ${decision.from} did not match ${decision.source}; stored ${decision.to}`
    );
  } else {
    logger?.info?.(
      `Repaired NeoForge server ${row.id} (${row.name}) Minecraft ${decision.from || '(empty)'} → ${decision.to}`
    );
  }
  return decision;
}

function repairPersistedRecords({ db, logger } = {}) {
  const database = db || require('../../db/connection');
  const log = logger || require('../../services/logger');
  const rows = database.prepare(`
    SELECT id, name, version, minecraft_version, loader_provider_id, loader_version, loader_metadata, data_path
    FROM servers
    WHERE kind = 'java' AND loader_provider_id = 'neoforge'
  `).all();
  const summary = { scanned: rows.length, repaired: 0, unchanged: 0, warned: 0, skipped: 0 };
  const tx = database.transaction(() => {
    for (const row of rows) {
      const decision = applyRow(database, row, decideRepair(row), log);
      if (decision.action === 'repair') summary.repaired += 1;
      else if (decision.action === 'warn') summary.warned += 1;
      else if (decision.action === 'skip') summary.skipped += 1;
      else summary.unchanged += 1;
    }
  });
  tx();
  try {
    database.prepare(`
      INSERT INTO schema_history (migration_key, schema_version, applied_at, result)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(migration_key) DO UPDATE SET
        schema_version = excluded.schema_version,
        applied_at = excluded.applied_at,
        result = excluded.result
    `).run(MIGRATION_KEY, '1', new Date().toISOString(), JSON.stringify(summary));
  } catch {
    /* schema_history may be unavailable in some test databases */
  }
  return summary;
}

module.exports = {
  MIGRATION_KEY,
  decideRepair,
  repairPersistedRecords,
};
