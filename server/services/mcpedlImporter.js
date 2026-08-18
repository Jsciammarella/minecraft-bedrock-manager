const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db/connection');
const logger = require('./logger');
const modManager = require('./modManager');
const packInstaller = require('./packInstaller');
const packFiles = require('./packFiles');
const gitCatalog = require('./gitCatalogClient');
const platform = require('./platform');

const SCRIPT_PATH = path.join(__dirname, '../scripts/fetch-mcpedl-mod.py');
const MODS_DIR = path.join(__dirname, '../../data/mods');
const THUMBS_DIR = path.join(MODS_DIR, 'thumbs');
const MCPEDL_PREFIX = 'https://mcpedl.com';
const MCPEDL_WWW_PREFIX = 'https://www.mcpedl.com';
const IMPORT_TIMEOUT_MS = 20 * 60 * 1000;
const PYTHON_BINS = platform.pythonBins();
const SKIP_SLUGS = new Set(['addons', 'maps', 'texture-packs', 'skins', 'scripts', 'category', 'user']);

function normalizeUrl(url) {
  return String(url || '').trim();
}

function isValidMcpedlUrl(url) {
  try {
    const parsed = new URL(normalizeUrl(url));
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === 'https:' && (host === 'mcpedl.com' || host === 'www.mcpedl.com');
  } catch {
    return false;
  }
}

function canonicalProjectUrl(url) {
  const text = normalizeUrl(url);
  if (!isValidMcpedlUrl(text)) return text;
  try {
    const parsed = new URL(text);
    const parts = parsed.pathname.split('/').filter(Boolean);
    let slug = parts[parts.length - 1] || '';
    if (SKIP_SLUGS.has(slug) && parts.length > 1) slug = parts[parts.length - 2];
    if (!slug || SKIP_SLUGS.has(slug)) return `${MCPEDL_PREFIX}/`;
    return `${MCPEDL_PREFIX}/${slug}`;
  } catch {
    return text.split('?')[0];
  }
}

function pythonMissingError() {
  if (process.platform === 'win32') {
    return new Error('Python 3 is required to import MCPEDL URLs. The Windows installer bundles it under runtime\\python.');
  }
  return new Error('Python 3 is required to import MCPEDL URLs. Install python3 and try again.');
}

function fetchSidecarUrl() {
  return String(process.env.CURSEFORGE_FETCH_URL || '').replace(/\/$/, '');
}

function fetchWorkRoot() {
  if (process.env.CURSEFORGE_FETCH_WORKDIR) return process.env.CURSEFORGE_FETCH_WORKDIR;
  if (fetchSidecarUrl()) return '/tmp/mc-cf-import';
  return os.tmpdir();
}

function sidecarUnavailableError(err) {
  const detail = err?.cause?.code || err?.code || err?.message || '';
  if (err?.name === 'AbortError') {
    return new Error('MCPEDL import timed out after 20 minutes');
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(String(detail))) {
    return new Error(
      'CurseForge fetch sidecar is not running. Rebuild with docker compose so mc-curseforge-fetch is up.'
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

async function fetchViaSidecar(projectUrl, workDir) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMPORT_TIMEOUT_MS);
  try {
    const res = await fetch(`${fetchSidecarUrl()}/fetch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: projectUrl, root: workDir }),
      signal: controller.signal,
    });
    let payload = {};
    try {
      payload = await res.json();
    } catch {
      payload = {};
    }
    if (!res.ok || payload.ok === false) {
      throw new Error(payload.error || `Catalog fetch sidecar returned ${res.status}`);
    }
  } catch (err) {
    throw sidecarUnavailableError(err);
  } finally {
    clearTimeout(timer);
  }
}

async function runFetchScript(projectUrl, workDir) {
  if (fetchSidecarUrl()) {
    await fetchViaSidecar(projectUrl, workDir);
    return;
  }
  await spawnPython([SCRIPT_PATH, projectUrl, '--root', workDir]);
}

function spawnPython(args, { timeoutMs = IMPORT_TIMEOUT_MS, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const tryBin = (index) => {
      if (index >= PYTHON_BINS.length) {
        reject(pythonMissingError());
        return;
      }
      const bin = PYTHON_BINS[index];
      const child = spawn(bin, args, {
        cwd,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      let retrying = false;
      let timer = null;

      const finish = (err, result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (err) reject(err);
        else resolve(result);
      };
      child.on('error', (err) => {
        if (err.code === 'ENOENT') {
          retrying = true;
          if (timer) clearTimeout(timer);
          tryBin(index + 1);
          return;
        }
        finish(err);
      });

      timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new Error('MCPEDL import timed out after 20 minutes'));
      }, timeoutMs);

      child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        stderr += text;
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) logger.info(`[mcpedl] ${line.trim()}`);
        }
      });
      child.on('close', (code) => {
        if (retrying) return;
        if (code === 0) {
          finish(null, { stdout, stderr });
          return;
        }
        const detail = stderr.trim().replace(/^Error:\s*/i, '') || stdout.trim() || `Python exited with code ${code}`;
        finish(new Error(detail));
      });
    };
    tryBin(0);
  });
}

function findModJson(rootDir) {
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    const meta = path.join(dir, 'mod.json');
    if (fs.existsSync(meta)) return meta;
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).isDirectory()) stack.push(full);
      } catch {
        // ignore
      }
    }
  }
  return null;
}

function existingLibraryMod(externalId, slugs) {
  const ids = [externalId, ...slugs].filter(Boolean);
  for (const value of ids) {
    const match = db.prepare(
      'SELECT * FROM mods WHERE curseforge_id = ? OR slug = ? LIMIT 1'
    ).get(String(value), String(value));
    if (match) return match;
  }
  return null;
}

function copyThumb(srcPath, modId) {
  if (!srcPath || !fs.existsSync(srcPath)) return '';
  const ext = path.extname(srcPath).toLowerCase() || '.png';
  const destName = modManager.getAvailableThumbName(modId, ext);
  const destPath = path.join(THUMBS_DIR, destName);
  fs.mkdirSync(THUMBS_DIR, { recursive: true });
  fs.copyFileSync(srcPath, destPath);
  return destPath;
}

async function importFromUrl(url) {
  const projectUrl = canonicalProjectUrl(url);
  if (!isValidMcpedlUrl(projectUrl)) {
    throw new Error('URL must start with "https://mcpedl.com"');
  }

  let parsed;
  try {
    parsed = new URL(projectUrl);
  } catch {
    throw new Error('That does not look like a valid MCPEDL URL');
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  const projectSlug = parts[parts.length - 1];
  if (!projectSlug || SKIP_SLUGS.has(projectSlug)) {
    throw new Error('Paste a full MCPEDL project URL, including the addon or pack name');
  }

  const workRoot = fetchWorkRoot();
  fs.mkdirSync(workRoot, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(workRoot, 'job-'));
  let filePath = '';
  try {
    await runFetchScript(projectUrl, workDir);
    const metaPath = findModJson(workDir);
    if (!metaPath) {
      throw new Error('The MCPEDL fetch script did not create a catalog folder');
    }
    const catalogMod = gitCatalog.parseModMetaFile(metaPath, workDir);
    if (!catalogMod?.filePath || !fs.existsSync(catalogMod.filePath)) {
      throw new Error(
        'Could not download a pack file from this MCPEDL page. The project may not have a downloadable .mcaddon or .mcpack.'
      );
    }

    const ext = path.extname(catalogMod.filePath).toLowerCase();
    if (!packFiles.isImportExt(ext)) {
      throw new Error(packFiles.unsupportedMessage(ext));
    }

    const duplicate = existingLibraryMod(projectSlug, [catalogMod.slug, projectSlug]);
    if (duplicate) {
      throw new Error(`"${duplicate.name}" is already in the library`);
    }

    await packInstaller.verifyArchive(catalogMod.filePath);

    const safeName = modManager.getAvailableFilename(
      modManager.sanitizeFilename(path.basename(catalogMod.filePath))
    );
    fs.mkdirSync(MODS_DIR, { recursive: true });
    filePath = path.join(MODS_DIR, safeName);
    fs.copyFileSync(catalogMod.filePath, filePath);
    const fileSize = fs.statSync(filePath).size;
    const slug = modManager.getAvailableSlug(catalogMod.slug || catalogMod.name || projectSlug);

    const insert = db.prepare(`
      INSERT INTO mods (name, slug, type, version, description, author, thumbnail, file_path, file_size, curseforge_id, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'mcpedl')
    `);

    let result;
    try {
      result = insert.run(
        catalogMod.name || projectSlug,
        slug,
        catalogMod.type || packFiles.typeFromExt(safeName, 'addon'),
        catalogMod.version || '1.0.0',
        catalogMod.description || '',
        catalogMod.author || '',
        '',
        filePath,
        fileSize,
        projectSlug
      );
    } catch (err) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      if (String(err.message || '').includes('UNIQUE constraint failed')) {
        throw new Error(`"${catalogMod.name || projectSlug}" is already in the library`);
      }
      throw err;
    }

    try {
      const thumbPath = copyThumb(catalogMod.thumbnailPath, result.lastInsertRowid);
      if (thumbPath) {
        db.prepare('UPDATE mods SET thumbnail = ? WHERE id = ?').run(thumbPath, result.lastInsertRowid);
      } else {
        await modManager.attachArchiveThumbnail(result.lastInsertRowid, filePath);
      }
    } catch (thumbErr) {
      logger.warn(`Could not save MCPEDL thumbnail: ${thumbErr.message}`);
      await modManager.attachArchiveThumbnail(result.lastInsertRowid, filePath);
    }

    logger.info(`Imported MCPEDL mod: ${catalogMod.name || projectSlug}`);
    return db.prepare('SELECT * FROM mods WHERE id = ?').get(result.lastInsertRowid);
  } catch (err) {
    if (filePath && fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    }
    throw err;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function validateOnly(url) {
  if (!isValidMcpedlUrl(url)) {
    return Promise.reject(new Error('URL must start with "https://mcpedl.com"'));
  }
  const canonical = canonicalProjectUrl(url);
  const parts = new URL(canonical).pathname.split('/').filter(Boolean);
  if (!parts.length || SKIP_SLUGS.has(parts[parts.length - 1])) {
    return Promise.reject(new Error('Not an MCPEDL project URL'));
  }
  return Promise.resolve({ ok: true, url: canonical });
}

module.exports = {
  MCPEDL_PREFIX,
  SCRIPT_PATH,
  isValidMcpedlUrl,
  canonicalProjectUrl,
  importFromUrl,
  validateOnly,
};
