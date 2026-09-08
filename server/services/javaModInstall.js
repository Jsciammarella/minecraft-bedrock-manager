const fs = require('fs');
const path = require('path');
const db = require('../db/connection');
const pluginAudit = require('./pluginAudit');
const javaLoaderRegistry = require('./javaLoaderRegistry');
const javaModMetadata = require('./javaModMetadata');
const catalogModMeta = require('./catalogModMeta');
const controlledFs = require('./controlledFs');
const javaModFiles = require('./javaModFiles');
const modCompatibility = require('./modCompatibility');
const minecraftVersions = require('./minecraftVersions');

const OVERRIDEABLE_REASONS = new Set([
  'VERSION_MISMATCH',
  'LOADER_MISMATCH',
  'UNKNOWN_METADATA',
  'METADATA_DISAGREEMENT',
]);
const BLOCKED_REASONS = new Set([
  'CLIENT_ONLY',
  'EDITION_MISMATCH',
  'NO_FILES',
  'LOADER_NO_MODS',
  'DUPLICATE',
]);

function publicCandidate(file) {
  if (!file) return null;
  return {
    name: file.name || path.basename(file.path || ''),
    sha256: file.sha256 || '',
    loader: file.loader || 'unknown',
    minecraftVersions: file.minecraftVersions || [],
    environment: file.environment || 'unknown',
    version: file.version || '',
  };
}

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

function classifyReasons(server, mod, file) {
  const reasons = [];
  if (String(mod?.edition || '').toLowerCase() && String(mod.edition).toLowerCase() !== 'java') {
    reasons.push('EDITION_MISMATCH');
  }
  if (!file) {
    reasons.push('NO_FILES');
    return reasons;
  }
  if (file.environment === 'client' || mod.environment === 'client') {
    reasons.push('CLIENT_ONLY');
  }
  const loaderId = String(server?.loader_provider_id || server?.loaderProviderId || 'vanilla');
  const support = javaLoaderRegistry.get(loaderId)?.provider.getModSupport?.() || { supportsMods: false };
  if (!support.supportsMods || loaderId === 'vanilla') reasons.push('LOADER_NO_MODS');
  const fileLoader = catalogModMeta.normalizeLoader(file.loader || mod.loader, 'java');
  const declared = catalogModMeta.normalizeLoader(mod.loader, 'java');
  if (fileLoader === 'unknown' && declared === 'unknown' && !file.minecraftVersions?.length) {
    reasons.push('UNKNOWN_METADATA');
  } else {
    if (fileLoader === 'unknown' || !(file.minecraftVersions || []).length) {
      reasons.push('UNKNOWN_METADATA');
    }
    if (fileLoader !== 'unknown' && !modCompatibility.loadersCompatible(fileLoader, loaderId, { allowUnknown: false })) {
      reasons.push('LOADER_MISMATCH');
    }
    const versions = file.minecraftVersions || minecraftVersions.modMinecraftVersions(mod);
    const metadata = parseJson(mod.metadata_json, mod.metadata || {});
    const dependencies = Array.isArray(mod.dependencies)
      ? mod.dependencies
      : parseJson(mod.dependencies, []);
    const evaluated = javaModMetadata.evaluateMinecraftRequirement(
      minecraftVersions.serverMinecraftVersion(server),
      {
        loader: fileLoader !== 'unknown' ? fileLoader : declared,
        metadata,
        dependencies,
      }
    );
    if (evaluated) {
      if (!evaluated.compatible) reasons.push('VERSION_MISMATCH');
    } else if (versions.length && !minecraftVersions.supportsMinecraftVersion(versions, minecraftVersions.serverMinecraftVersion(server))) {
      reasons.push('VERSION_MISMATCH');
    }
  }
  if (
    declared
    && fileLoader
    && declared !== 'unknown'
    && fileLoader !== 'unknown'
    && declared !== fileLoader
    && !modCompatibility.loadersCompatible(declared, fileLoader, { allowUnknown: false })
  ) {
    reasons.push('METADATA_DISAGREEMENT');
  }
  return [...new Set(reasons)];
}

function canOverrideReasons(reasons = []) {
  if (!reasons.length) return true;
  if (reasons.some((code) => BLOCKED_REASONS.has(code))) return false;
  return reasons.every((code) => OVERRIDEABLE_REASONS.has(code));
}

function blockedOverrideError(reasons) {
  if (reasons.includes('CLIENT_ONLY')) {
    return Object.assign(new Error('Client-only files cannot be installed on a dedicated server'), {
      status: 400,
      code: 'CLIENT_ONLY',
      reasons,
    });
  }
  if (reasons.includes('EDITION_MISMATCH')) {
    return Object.assign(new Error('Bedrock packs cannot be installed on a Java server'), {
      status: 400,
      code: 'EDITION_MISMATCH',
      reasons,
    });
  }
  if (reasons.includes('LOADER_NO_MODS')) {
    return Object.assign(new Error('This Java loader does not support mods'), {
      status: 400,
      code: 'LOADER_NO_MODS',
      reasons,
    });
  }
  if (reasons.includes('NO_FILES')) {
    return Object.assign(new Error('No jar in this library mod matches this server'), {
      status: 400,
      code: 'NO_FILES',
      reasons,
    });
  }
  return Object.assign(new Error('Compatibility cannot be overridden for this mod'), {
    status: 400,
    code: 'OVERRIDE_NOT_ALLOWED',
    reasons,
  });
}

function validate(server, mod, { file, override = false } = {}) {
  const chosen = file || javaModFiles.bestFileForServer(mod, server, {
    allowMismatch: override,
  });
  const artifact = artifactFromRow(mod, chosen);
  if (artifact.edition && artifact.edition !== 'java') {
    return { ok: false, error: 'Bedrock packs cannot be installed on a Java server', code: 'EDITION_MISMATCH' };
  }
  if ((chosen?.environment || artifact.environment) === 'client') {
    return { ok: false, error: 'Client-only files cannot be installed on a dedicated server', code: 'CLIENT_ONLY' };
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
  const reasons = classifyReasons(server, mod, chosen);
  if (!result.ok) {
    if (override && canOverrideReasons(reasons)) {
      warnings.push(`${result.error} Installed anyway; it may not work on this Minecraft version or launcher.`);
      return { ok: true, warnings, missingDependencies: missing, override: true, file: chosen, reasons };
    }
    return { ...result, reasons };
  }
  if (override && chosen && !javaModFiles.fileMatchesServer(chosen, server)) {
    if (!canOverrideReasons(reasons)) {
      return { ok: false, error: blockedOverrideError(reasons).message, code: blockedOverrideError(reasons).code, reasons };
    }
    warnings.push('This file does not match this server Minecraft version or launcher and may not work.');
  }
  return { ok: true, warnings, missingDependencies: missing, override: Boolean(override), file: chosen, reasons };
}

function install(server, modId, { fileSha256, override = false, actor } = {}) {
  require('./javaHostingPolicy').assertServerEditionAvailable('java', 'install-mod');
  if (String(server?.kind || '') !== 'java') {
    throw Object.assign(new Error('Java mod installation requires a local Java server'), { status: 400 });
  }
  if (server.remote_host) {
    throw Object.assign(new Error('Remote servers do not support mods'), { status: 400 });
  }
  const mod = db.prepare('SELECT * FROM mods WHERE id = ?').get(modId);
  if (!mod) throw Object.assign(new Error('Mod not found'), { status: 404 });
  if (!catalogModMeta.isJavaMod(mod)) {
    throw Object.assign(new Error('Bedrock packs cannot be installed on a Java server'), { status: 400, code: 'EDITION_MISMATCH' });
  }
  const existing = db.prepare('SELECT * FROM server_mods WHERE server_id = ? AND mod_id = ?').get(server.id, modId);
  if (existing) throw Object.assign(new Error('Mod already installed on this server'), { status: 400, code: 'DUPLICATE' });
  const files = javaModFiles.listFiles(mod);
  const nonClient = files.filter((file) => file.environment !== 'client');
  const matched = javaModFiles.matchingFiles(mod, server);
  if (override && !fileSha256 && !matched.length && nonClient.length > 1) {
    throw Object.assign(new Error('Select a JAR file to install'), {
      status: 400,
      code: 'FILE_SELECTION_REQUIRED',
      files: nonClient.map(publicCandidate),
    });
  }
  const chosen = javaModFiles.bestFileForServer(mod, server, {
    sha256: fileSha256,
    allowMismatch: override,
  });
  const reasons = classifyReasons(server, mod, chosen);
  const auditBase = {
    actorId: actor?.id || actor?.username || null,
    modId,
    fileSha256: chosen?.sha256 || fileSha256 || '',
    reasonCodes: reasons,
    override: Boolean(override),
  };
  const fail = (err) => {
    pluginAudit.record('java.mod.install', {
      targetType: 'server',
      targetId: String(server.id),
      detail: { ...auditBase, success: false, error: err.code || 'INSTALL_FAILED' },
    });
    throw err;
  };
  if (!chosen?.path || !fs.existsSync(chosen.path)) {
    if (files.length && files.every((file) => file.environment === 'client')) {
      fail(blockedOverrideError(['CLIENT_ONLY']));
    }
    if (!override && files.length) {
      fail(Object.assign(new Error('This mod does not match this server Minecraft version and launcher'), {
        status: 400,
        reasons,
      }));
    }
    fail(Object.assign(new Error('No jar in this library mod matches this server'), { status: 400, code: 'NO_FILES', reasons }));
  }
  if (chosen.environment === 'client') {
    fail(blockedOverrideError(['CLIENT_ONLY']));
  }
  if (!override && !javaModFiles.fileMatchesServer(chosen, server)) {
    fail(Object.assign(new Error('This mod does not match this server Minecraft version and launcher'), {
      status: 400,
      reasons,
    }));
  }
  if (override && !javaModFiles.fileMatchesServer(chosen, server) && !canOverrideReasons(reasons)) {
    fail(blockedOverrideError(reasons));
  }
  const check = validate(server, mod, { file: chosen, override });
  if (!check.ok) fail(Object.assign(new Error(check.error), { status: 400, code: check.code, reasons: check.reasons || reasons }));
  const { dir } = modsDirFor(server);
  const running = server.status === 'running' || server.status === 'starting';
  const destRel = destName(mod, null, chosen);
  const dest = path.join(dir, destRel);
  const staged = running ? `${dest}.pending` : null;
  const overrideFlag = override && !javaModFiles.fileMatchesServer(chosen, server) ? 1 : 0;
  try {
    if (running) {
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
  } catch (err) {
    try { if (staged) fs.rmSync(staged, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
    try {
      db.prepare('DELETE FROM server_mods WHERE server_id = ? AND mod_id = ?').run(server.id, modId);
    } catch { /* ignore */ }
    fail(err);
  }
  pluginAudit.record('java.mod.install', {
    targetType: 'server',
    targetId: String(server.id),
    detail: {
      ...auditBase,
      success: true,
      pending: running,
      immediate: !running,
      missingDependencies: (check.missingDependencies || []).map((item) => item.id),
      override: Boolean(overrideFlag),
    },
  });
  return { warnings: check.warnings || [], restartRequired: running, override: Boolean(overrideFlag), reasons };
}

function remove(server, installationId) {
  require('./javaHostingPolicy').assertServerEditionAvailable('java', 'remove-mod');
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
  OVERRIDEABLE_REASONS,
  BLOCKED_REASONS,
  applyPending,
  artifactFromRow,
  canOverrideReasons,
  classifyReasons,
  destName,
  install,
  list,
  pending,
  remove,
  validate,
};
