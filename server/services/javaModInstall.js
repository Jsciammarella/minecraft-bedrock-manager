const fs = require('fs');
const path = require('path');
const db = require('../db/connection');
const pluginAudit = require('./pluginAudit');
const javaLoaderRegistry = require('./javaLoaderRegistry');
const javaModMetadata = require('./javaModMetadata');
const catalogModMeta = require('./catalogModMeta');
const controlledFs = require('./controlledFs');
const javaModFiles = require('./javaModFiles');

function parseJson(raw, fallback) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function artifactFromRow(row, file) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    edition: row.edition || 'bedrock',
    artifactType: row.artifact_type || row.type,
    loader: file?.loader || row.loader || 'any',
    minecraftVersions: file?.minecraftVersions || parseJson(row.minecraft_versions, []),
    environment: file?.environment || row.environment || 'unknown',
    dependencies: parseJson(row.dependencies, []),
    sourceType: row.source || 'upload',
    sourceUrl: row.source_url || '',
    license: row.license || '',
    sha256: file?.sha256 || row.sha256 || '',
    fileSize: file?.size || row.file_size,
    warning: row.warning || '',
    metadata: parseJson(row.metadata_json, {}),
    filePath: file?.path || row.file_path,
  };
}

function publicInstall(row, mod) {
  return {
    id: row.id,
    modId: row.mod_id,
    status: row.status || 'installed',
    pendingAction: row.pending_action || null,
    installedAt: row.installed_at,
    installedFile: row.installed_file || path.basename(mod?.file_path || ''),
    compatibilityOverride: Boolean(row.compatibility_override),
    mod: artifactFromRow(mod),
  };
}

function modsDirFor(server) {
  const entry = javaLoaderRegistry.get(server.loader_provider_id || 'vanilla');
  const support = entry?.provider.getModSupport?.() || { supportsMods: false, modsDirectory: 'mods' };
  if (!support.supportsMods) {
    const err = new Error('This Java loader does not support mods');
    err.status = 400;
    throw err;
  }
  const rel = support.modsDirectory || 'mods';
  const dir = controlledFs.resolveInRoot(server.data_path, rel);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, rel, provider: entry.provider };
}

function list(serverId) {
  const rows = db.prepare(`
    SELECT sm.*, m.name, m.edition, m.artifact_type, m.loader, m.minecraft_versions,
      m.environment, m.dependencies, m.source, m.source_url, m.license, m.sha256, m.file_size, m.warning, m.file_path, m.type, m.metadata_json
    FROM server_mods sm
    JOIN mods m ON m.id = sm.mod_id
    WHERE sm.server_id = ?
  `).all(serverId);
  return rows.map((row) => publicInstall(row, row));
}

function pending(serverId) {
  return list(serverId).filter((item) => item.pendingAction || item.status === 'pending');
}

function jarLoader(artifact) {
  try {
    if (artifact?.filePath && fs.existsSync(artifact.filePath)) {
      const info = javaModMetadata.inspectJar(artifact.filePath);
      if (info.loader && info.loader !== 'any' && info.loader !== 'unknown') return info.loader;
    }
  } catch {
    /* keep declared loader */
  }
  return artifact?.loader || 'unknown';
}

function destName(mod, row, file) {
  if (row?.installed_file) return path.basename(row.installed_file);
  if (file?.path) return path.basename(file.path);
  return path.basename(mod?.file_path || `${mod?.slug || mod?.id || 'mod'}.jar`);
}

function validate(server, mod, { file, override = false } = {}) {
  const chosen = file || javaModFiles.bestFileForServer(mod, server, {
    allowMismatch: override,
  });
  const artifact = artifactFromRow(mod, chosen);
  if (artifact.edition && artifact.edition !== 'java') {
    return { ok: false, error: 'Bedrock packs cannot be installed on a Java server' };
  }
  artifact.loader = catalogModMeta.normalizeLoader(jarLoader(artifact), 'java');
  const { provider } = modsDirFor(server);
  const result = provider.validateMod(server, artifact);
  const installed = list(server.id);
  const missing = (artifact.dependencies || []).filter((dep) => {
    if (!dep?.id) return false;
    if (['minecraft', 'java', 'fabricloader', 'neoforge', 'forge'].includes(String(dep.id).toLowerCase())) return false;
    return !installed.some((item) => {
      return String(item.mod?.name || '').toLowerCase() === String(dep.id).toLowerCase();
    });
  });
  const warnings = [...(result.warnings || [])];
  if (missing.length) warnings.push(`Missing dependencies: ${missing.map((item) => item.id).join(', ')}`);
  if (artifact.environment === 'unknown') warnings.push('Compatibility is unknown for this file.');
  if (!result.ok) {
    if (override) {
      warnings.push(`${result.error} Installed anyway; it may not work on this Minecraft version or launcher.`);
      return { ok: true, warnings, missingDependencies: missing, override: true, file: chosen };
    }
    return result;
  }
  if (override && chosen && !javaModFiles.fileMatchesServer(chosen, server)) {
    warnings.push('This file does not match this server Minecraft version or launcher and may not work.');
  }
  return { ok: true, warnings, missingDependencies: missing, override: Boolean(override), file: chosen };
}

function install(server, modId, { fileSha256, override = false } = {}) {
  const mod = db.prepare('SELECT * FROM mods WHERE id = ?').get(modId);
  if (!mod) throw Object.assign(new Error('Mod not found'), { status: 404 });
  const existing = db.prepare('SELECT * FROM server_mods WHERE server_id = ? AND mod_id = ?').get(server.id, modId);
  if (existing) throw Object.assign(new Error('Mod already installed on this server'), { status: 400 });
  const chosen = javaModFiles.bestFileForServer(mod, server, {
    sha256: fileSha256,
    allowMismatch: override,
  });
  if (!chosen?.path || !fs.existsSync(chosen.path)) {
    throw Object.assign(new Error('No jar in this library mod matches this server'), { status: 400 });
  }
  if (!override && !javaModFiles.fileMatchesServer(chosen, server)) {
    throw Object.assign(new Error('This mod does not match this server Minecraft version and launcher'), { status: 400 });
  }
  const check = validate(server, mod, { file: chosen, override });
  if (!check.ok) throw Object.assign(new Error(check.error), { status: 400 });
  const { dir } = modsDirFor(server);
  const running = server.status === 'running' || server.status === 'starting';
  const destRel = destName(mod, null, chosen);
  const dest = path.join(dir, destRel);
  const overrideFlag = override && !javaModFiles.fileMatchesServer(chosen, server) ? 1 : 0;
  if (running) {
    const staged = `${dest}.pending`;
    fs.copyFileSync(chosen.path, staged);
    db.prepare(`
      INSERT INTO server_mods (server_id, mod_id, status, pending_action, staged_path, installed_file, compatibility_override)
      VALUES (?, ?, 'pending', 'install', ?, ?, ?)
    `).run(server.id, modId, staged, destRel, overrideFlag);
  } else {
    fs.copyFileSync(chosen.path, dest);
    db.prepare(`
      INSERT INTO server_mods (server_id, mod_id, status, installed_file, compatibility_override)
      VALUES (?, ?, 'installed', ?, ?)
    `).run(server.id, modId, destRel, overrideFlag);
  }
  pluginAudit.record('java.mod.install', {
    targetType: 'server',
    targetId: String(server.id),
    detail: { modId, name: mod.name, file: destRel, override: Boolean(overrideFlag), staged: running },
  });
  return { warnings: check.warnings || [], restartRequired: running, override: Boolean(overrideFlag) };
}

function remove(server, installationId) {
  const row = db.prepare('SELECT * FROM server_mods WHERE id = ? AND server_id = ?').get(installationId, server.id);
  if (!row) throw Object.assign(new Error('Installation not found'), { status: 404 });
  const mod = db.prepare('SELECT * FROM mods WHERE id = ?').get(row.mod_id);
  const { dir } = modsDirFor(server);
  const dest = path.join(dir, destName(mod || {}, row));
  const running = server.status === 'running' || server.status === 'starting';
  if (running) {
    db.prepare(`UPDATE server_mods SET pending_action = 'remove', status = 'pending' WHERE id = ?`).run(row.id);
  } else {
    try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
    if (row.staged_path) try { fs.rmSync(row.staged_path, { force: true }); } catch { /* ignore */ }
    db.prepare('DELETE FROM server_mods WHERE id = ?').run(row.id);
  }
  pluginAudit.record('java.mod.remove', {
    targetType: 'server',
    targetId: String(server.id),
    detail: { installationId, libraryPreserved: true },
  });
  return { restartRequired: running, libraryPreserved: true };
}

function applyPending(server) {
  const rows = db.prepare('SELECT * FROM server_mods WHERE server_id = ? AND pending_action IS NOT NULL').all(server.id);
  if (!rows.length) return;
  const { dir } = modsDirFor(server);
  for (const row of rows) {
    const mod = db.prepare('SELECT * FROM mods WHERE id = ?').get(row.mod_id);
    const dest = path.join(dir, destName(mod || {}, row));
    if (row.pending_action === 'install' && row.staged_path && fs.existsSync(row.staged_path)) {
      fs.copyFileSync(row.staged_path, dest);
      fs.rmSync(row.staged_path, { force: true });
      db.prepare(`UPDATE server_mods SET status = 'installed', pending_action = NULL, staged_path = NULL WHERE id = ?`).run(row.id);
    } else if (row.pending_action === 'remove') {
      try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
      db.prepare('DELETE FROM server_mods WHERE id = ?').run(row.id);
    }
  }
}

module.exports = {
  applyPending,
  artifactFromRow,
  destName,
  install,
  list,
  pending,
  remove,
  validate,
};
