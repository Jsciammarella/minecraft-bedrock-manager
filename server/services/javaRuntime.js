const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const axios = require('axios');
const logger = require('./logger');
const platform = require('./platform');

const execFileAsync = promisify(execFile);

const USER_AGENT = 'minecraft-manager-java';
const PRODUCTS_URL = 'https://piston-meta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const RUNTIMES_DIR = path.join(__dirname, '../../data/java-runtimes');
const DOWNLOAD_CONCURRENCY = 8;
const JAVA_EXE = platform.isWindows ? 'java.exe' : 'java';

const inflight = new Map();

function componentForMajor(major) {
  const n = Number(major) || 17;
  if (n >= 25) return 'java-runtime-epsilon';
  if (n >= 21) return 'java-runtime-delta';
  return 'java-runtime-gamma';
}

function mojangPlatformKey() {
  if (process.platform === 'win32') {
    if (process.arch === 'arm64') return 'windows-arm64';
    if (process.arch === 'ia32') return 'windows-x86';
    return 'windows-x64';
  }
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  }
  if (process.arch === 'ia32') return 'linux-i386';
  return 'linux';
}

function adoptiumOs() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}

function adoptiumArch() {
  if (process.arch === 'arm64') return 'aarch64';
  if (process.arch === 'ia32') return 'x86';
  return 'x64';
}

function parseJavaMajor(text) {
  const quoted = String(text || '').match(/version "(\d+)(?:\.(\d+))?/);
  if (!quoted) return 0;
  const first = Number(quoted[1]);
  if (first === 1 && quoted[2]) return Number(quoted[2]);
  return first;
}

function javaHomeFromBin(javaBin) {
  return path.resolve(path.dirname(javaBin), '..');
}

function hashFile(filePath, algo) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algo);
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function findJavaBinary(root) {
  if (!root || !fs.existsSync(root)) return '';
  const preferred = [
    path.join(root, 'bin', JAVA_EXE),
    path.join(root, 'jre.bundle', 'Contents', 'Home', 'bin', JAVA_EXE),
  ];
  for (const candidate of preferred) {
    if (fs.existsSync(candidate)) return candidate;
  }

  const skip = new Set(['legal', 'lib', 'include', 'man', 'jmods', 'conf']);
  function walk(dir, depth) {
    if (depth > 6) return '';
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return ''; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === JAVA_EXE && path.basename(dir) === 'bin') return full;
      if (entry.isDirectory() && !skip.has(entry.name)) {
        const found = walk(full, depth + 1);
        if (found) return found;
      }
    }
    return '';
  }
  return walk(root, 0);
}

async function readJavaMajor(javaBin) {
  if (!javaBin) return 0;
  try {
    const { stdout, stderr } = await execFileAsync(javaBin, ['-version'], {
      timeout: 8000,
      windowsHide: true,
    });
    return parseJavaMajor(`${stderr || ''}\n${stdout || ''}`);
  } catch (err) {
    const text = [err.stderr, err.stdout, err.message].filter(Boolean).join('\n');
    if (/version/i.test(text)) return parseJavaMajor(text);
    return 0;
  }
}

function wellKnownInstalls() {
  const bins = [];
  if (platform.isWindows) {
    const roots = [
      'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Eclipse Foundation',
      'C:\\Program Files\\Java',
      'C:\\Program Files\\Microsoft',
      'C:\\Program Files\\Amazon Corretto',
      'C:\\Program Files\\Zulu',
      'C:\\Program Files\\BellSoft',
    ];
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      let names;
      try { names = fs.readdirSync(root); } catch { continue; }
      for (const name of names) {
        const exe = path.join(root, name, 'bin', JAVA_EXE);
        if (fs.existsSync(exe)) bins.push(exe);
      }
    }
    return bins;
  }

  const linuxRoots = ['/usr/lib/jvm', '/usr/lib64/jvm', '/Library/Java/JavaVirtualMachines'];
  for (const root of linuxRoots) {
    if (!fs.existsSync(root)) continue;
    let names;
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const name of names) {
      const candidates = [
        path.join(root, name, 'bin', JAVA_EXE),
        path.join(root, name, 'Contents', 'Home', 'bin', JAVA_EXE),
      ];
      bins.push(...candidates.filter((item) => fs.existsSync(item)));
    }
  }
  return bins;
}

function managedInstalls() {
  const bins = [];
  const roots = [
    path.join(RUNTIMES_DIR, 'mojang'),
    path.join(RUNTIMES_DIR, 'temurin'),
  ];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let names;
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const name of names) {
      const found = findJavaBinary(path.join(root, name));
      if (found) bins.push(found);
    }
  }
  return bins;
}

function uniqueExisting(paths) {
  const seen = new Set();
  const out = [];
  for (const item of paths) {
    if (!item) continue;
    const bare = item === JAVA_EXE || item === 'java' || item === 'java.exe';
    const resolved = bare ? item : path.resolve(item);
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (bare || fs.existsSync(resolved)) out.push(resolved);
  }
  return out;
}

async function findUsableJava(minMajor) {
  const candidates = uniqueExisting([
    process.env.MC_MANAGER_JAVA,
    process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, 'bin', JAVA_EXE),
    ...wellKnownInstalls(),
    ...managedInstalls(),
    platform.javaCommand(),
  ]);

  let fallback = '';
  let fallbackMajor = 0;
  for (const candidate of candidates) {
    const major = await readJavaMajor(candidate);
    if (major >= minMajor) {
      logger.info(`Using Java ${major} at ${candidate} for Minecraft (need ${minMajor}+)`);
      return candidate;
    }
    if (major > fallbackMajor) {
      fallback = candidate;
      fallbackMajor = major;
    }
  }
  if (fallback) {
    logger.warn(`System Java at ${fallback} is version ${fallbackMajor}; Minecraft needs ${minMajor}+`);
  }
  return '';
}

async function mapPool(items, limit, fn) {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      await fn(items[index], index);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) || 1 }, () => worker());
  await Promise.all(workers);
}

async function downloadRaw(url, dest, sha1) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (sha1 && fs.existsSync(dest)) {
    const digest = await hashFile(dest, 'sha1');
    if (digest.toLowerCase() === sha1.toLowerCase()) return;
  }
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 180000,
        maxRedirects: 5,
        headers: { 'User-Agent': USER_AGENT },
      });
      fs.writeFileSync(dest, Buffer.from(response.data));
      if (sha1) {
        const digest = await hashFile(dest, 'sha1');
        if (digest.toLowerCase() !== sha1.toLowerCase()) {
          fs.unlinkSync(dest);
          throw new Error('SHA-1 mismatch');
        }
      }
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function ensureMojangRuntime(component) {
  const root = path.join(RUNTIMES_DIR, 'mojang', component);
  const readyPath = path.join(root, '.ready.json');
  const existing = findJavaBinary(root);
  if (existing && fs.existsSync(readyPath)) return existing;

  const { data: products } = await axios.get(PRODUCTS_URL, {
    timeout: 20000,
    headers: { 'User-Agent': USER_AGENT },
  });
  const osKey = mojangPlatformKey();
  const list = products?.[osKey]?.[component];
  const entry = Array.isArray(list) ? list[0] : null;
  if (!entry?.manifest?.url) {
    throw new Error(`Mojang does not publish ${component} for ${osKey}`);
  }

  const { data: manifest } = await axios.get(entry.manifest.url, {
    timeout: 30000,
    headers: { 'User-Agent': USER_AGENT },
  });
  const files = Object.entries(manifest?.files || {});
  const toDownload = files.filter(([, info]) => info?.type === 'file' && info?.downloads?.raw?.url);
  logger.info(`Downloading Mojang ${component} (${entry.version?.name || 'JRE'}, ${toDownload.length} files)`);

  fs.mkdirSync(root, { recursive: true });
  for (const [rel, info] of files) {
    if (info?.type === 'directory') fs.mkdirSync(path.join(root, ...rel.split('/')), { recursive: true });
  }

  let done = 0;
  await mapPool(toDownload, DOWNLOAD_CONCURRENCY, async ([rel, info]) => {
    const dest = path.join(root, ...rel.split('/'));
    await downloadRaw(info.downloads.raw.url, dest, info.downloads.raw.sha1 || '');
    if (info.executable) platform.chmodIfNeeded(dest);
    done += 1;
    if (done === toDownload.length || done % 50 === 0) {
      logger.info(`Mojang ${component}: ${done}/${toDownload.length} files`);
    }
  });

  const bin = findJavaBinary(root);
  if (!bin) throw new Error(`Mojang ${component} downloaded but java was not found`);
  fs.writeFileSync(readyPath, `${JSON.stringify({
    component,
    version: entry.version?.name || '',
    installedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  logger.info(`Installed Mojang ${component} Java at ${bin}`);
  return bin;
}

async function extractArchive(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (platform.isWindows && /\.zip$/i.test(archivePath)) {
    await platform.unzipArchive(archivePath, destDir);
    return;
  }
  const tarBin = platform.isWindows
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  await execFileAsync(tarBin, ['-xf', archivePath, '-C', destDir], {
    timeout: 180000,
    windowsHide: true,
  });
}

async function ensureTemurin(major) {
  const root = path.join(RUNTIMES_DIR, 'temurin', String(major));
  const readyPath = path.join(root, '.ready.json');
  const existing = findJavaBinary(root);
  if (existing && fs.existsSync(readyPath)) return existing;

  const { data } = await axios.get(`https://api.adoptium.net/v3/assets/latest/${major}/hotspot`, {
    timeout: 20000,
    params: {
      os: adoptiumOs(),
      architecture: adoptiumArch(),
      image_type: 'jre',
      vendor: 'eclipse',
    },
    headers: { 'User-Agent': USER_AGENT },
  });
  const asset = Array.isArray(data) ? data[0] : null;
  const pkg = asset?.binary?.package;
  if (!pkg?.link) {
    throw new Error(`Eclipse Temurin Java ${major} JRE is not published for this OS`);
  }

  fs.mkdirSync(root, { recursive: true });
  const archiveName = pkg.name || `temurin-${major}.zip`;
  const archivePath = path.join(root, archiveName);
  logger.info(`Downloading Eclipse Temurin Java ${major} (${archiveName})`);
  const response = await axios.get(pkg.link, {
    responseType: 'arraybuffer',
    timeout: 180000,
    maxRedirects: 5,
    headers: { 'User-Agent': USER_AGENT },
  });
  fs.writeFileSync(archivePath, Buffer.from(response.data));
  if (pkg.checksum) {
    const digest = await hashFile(archivePath, 'sha256');
    if (digest.toLowerCase() !== String(pkg.checksum).toLowerCase()) {
      fs.unlinkSync(archivePath);
      throw new Error(`Temurin Java ${major} failed SHA-256 verification`);
    }
  }
  await extractArchive(archivePath, root);
  try { fs.unlinkSync(archivePath); } catch { /* keep the JRE even if cleanup fails */ }

  const bin = findJavaBinary(root);
  if (!bin) throw new Error(`Temurin Java ${major} extracted but java was not found`);
  platform.chmodIfNeeded(bin);
  fs.writeFileSync(readyPath, `${JSON.stringify({
    major,
    version: asset.version?.openjdk_version || String(major),
    installedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  logger.info(`Installed Temurin Java ${major} at ${bin}`);
  return bin;
}

async function ensureJava({ major, component } = {}) {
  const needMajor = Math.max(17, Number(major) || 17);
  const needComponent = component || componentForMajor(needMajor);
  const key = `${needComponent}:${needMajor}`;
  if (inflight.has(key)) return inflight.get(key);

  const work = (async () => {
    const existing = await findUsableJava(needMajor);
    if (existing) return existing;

    logger.info(`Installing a managed Java ${needMajor} runtime for Minecraft Java Edition`);
    try {
      const bin = await ensureMojangRuntime(needComponent);
      const got = await readJavaMajor(bin);
      if (got >= needMajor) return bin;
      throw new Error(`Managed Mojang JRE is Java ${got}, need ${needMajor}`);
    } catch (err) {
      logger.warn(`Mojang Java runtime unavailable (${err.message}); trying Eclipse Temurin`);
      const bin = await ensureTemurin(needMajor);
      const got = await readJavaMajor(bin);
      if (got >= needMajor) return bin;
      throw new Error(
        `Could not install Java ${needMajor} or newer. Current Minecraft Java Edition requires a newer JRE than the one on PATH.`
      );
    }
  })().finally(() => inflight.delete(key));

  inflight.set(key, work);
  return work;
}

module.exports = {
  RUNTIMES_DIR,
  componentForMajor,
  ensureJava,
  javaHomeFromBin,
  mojangPlatformKey,
  parseJavaMajor,
  readJavaMajor,
};
