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

const SCRIPT_PATH = path.join(__dirname, '../scripts/fetch-curseforge-mod.py');
const MODS_DIR = path.join(__dirname, '../../data/mods');
const THUMBS_DIR = path.join(MODS_DIR, 'thumbs');
const CURSEFORGE_PREFIX = 'https://www.curseforge.com/minecraft-bedrock';
const IMPORT_TIMEOUT_MS = 20 * 60 * 1000;
const PYTHON_BINS = process.platform === 'win32'
  ? ['python', 'python3', 'py']
  : ['python3', 'python'];

function normalizeUrl(url) {
  return String(url || '').trim();
}

function isValidCurseforgeUrl(url) {
  return normalizeUrl(url).startsWith(CURSEFORGE_PREFIX);
}

function canonicalProjectUrl(url) {
  const text = normalizeUrl(url);
  if (!isValidCurseforgeUrl(text)) return text;
  try {
    const parsed = new URL(text);
    const parts = parsed.pathname.split('/').filter(Boolean).slice(0, 3);
    return `https://www.curseforge.com/${parts.join('/')}`;
  } catch {
    return text.split('?')[0];
  }
}

function pythonMissingError() {
  return new Error('Python 3 is required to import CurseForge URLs. Install python3 and try again.');
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
        finish(new Error('CurseForge import timed out after 20 minutes'));
      }, timeoutMs);

      child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        stderr += text;
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) logger.info(`[curseforge] ${line.trim()}`);
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

function existingLibraryMod(curseforgeId, slugs) {
  const ids = [curseforgeId, ...slugs].filter(Boolean);
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
  if (!isValidCurseforgeUrl(projectUrl)) {
    throw new Error('URL must start with "https://www.curseforge.com/minecraft-bedrock"');
  }

  let parsed;
  try {
    parsed = new URL(projectUrl);
  } catch {
    throw new Error('That does not look like a valid CurseForge URL');
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 3) {
    throw new Error('Paste a full CurseForge project URL, including the addon or pack name');
  }

  const projectSlug = parts[2];
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cf-import-'));
  let filePath = '';
  try {
    await spawnPython([SCRIPT_PATH, projectUrl, '--root', workDir]);
    const metaPath = findModJson(workDir);
    if (!metaPath) {
      throw new Error('The CurseForge fetch script did not create a catalog folder');
    }
    const catalogMod = gitCatalog.parseModMetaFile(metaPath, workDir);
    if (!catalogMod?.filePath || !fs.existsSync(catalogMod.filePath)) {
      throw new Error(
        'Could not download a pack file from this CurseForge page. The project may not have a downloadable .mcaddon or .mcpack.'
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
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'curseforge')
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
      logger.warn(`Could not save CurseForge thumbnail: ${thumbErr.message}`);
      await modManager.attachArchiveThumbnail(result.lastInsertRowid, filePath);
    }

    logger.info(`Imported CurseForge mod: ${catalogMod.name || projectSlug}`);
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
  if (!isValidCurseforgeUrl(url)) {
    return Promise.reject(new Error('URL must start with "https://www.curseforge.com/minecraft-bedrock"'));
  }
  const canonical = canonicalProjectUrl(url);
  const parts = new URL(canonical).pathname.split('/').filter(Boolean);
  if (parts.length < 3) {
    return Promise.reject(new Error('Not a CurseForge Bedrock project URL'));
  }
  return Promise.resolve({ ok: true, url: canonical });
}

module.exports = {
  CURSEFORGE_PREFIX,
  SCRIPT_PATH,
  isValidCurseforgeUrl,
  canonicalProjectUrl,
  importFromUrl,
  validateOnly,
};
