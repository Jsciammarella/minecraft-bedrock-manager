const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const logger = require('./logger');
const connectHost = require('./connectHost');

const DISCOVERY_PORT = 19132;
const PROXY_PORT_START = 19200;
const PROXY_PORT_END = 19299;
const VENDOR_DIR = path.join(__dirname, '../../vendor/phantom');
const BIN_DIR = path.join(__dirname, '../../data/phantom');
const BUNDLED_VERSION_PATH = path.join(VENDOR_DIR, 'VERSION');
const RUNTIME_VERSION_PATH = path.join(BIN_DIR, 'VERSION');
const GITHUB_API_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'minecraft-bedrock-manager',
  'X-GitHub-Api-Version': '2022-11-28',
};
const GITHUB_DOWNLOAD_HEADERS = {
  Accept: 'application/octet-stream',
  'User-Agent': 'minecraft-bedrock-manager',
};

const processes = new Map();
const lastErrors = new Map();

function binaryName() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'linux') {
    if (arch === 'arm64' || arch === 'aarch64') return 'phantom-linux-arm8';
    if (arch === 'arm') return 'phantom-linux-arm7';
    return 'phantom-linux';
  }
  if (platform === 'win32') return 'phantom-windows.exe';
  if (platform === 'darwin') return 'phantom-macos';
  throw new Error(`Phantom has no published binary for ${platform}/${arch}`);
}

function binaryPath() {
  return path.join(BIN_DIR, binaryName());
}

function vendorBinaryPath() {
  return path.join(VENDOR_DIR, binaryName());
}

function readVersionFile(filePath, fallback = '') {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return fallback;
  }
}

function bundledVersion() {
  return readVersionFile(BUNDLED_VERSION_PATH, 'v0.5.3');
}

function installedVersion() {
  return readVersionFile(RUNTIME_VERSION_PATH, '');
}

function installBinary(source, tag) {
  const dest = binaryPath();
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.copyFileSync(source, dest);
  if (fs.statSync(dest).size < 1000) {
    fs.unlinkSync(dest);
    throw new Error('Phantom binary was too small');
  }
  try { fs.chmodSync(dest, 0o755); } catch { /* windows */ }
  fs.writeFileSync(RUNTIME_VERSION_PATH, `${tag}\n`);
  return dest;
}

function ensureBinary() {
  const dest = binaryPath();
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) return dest;
  const vendor = vendorBinaryPath();
  if (!fs.existsSync(vendor) || fs.statSync(vendor).size < 1000) {
    throw new Error(`Phantom binary is not bundled for ${process.platform}/${process.arch} (${binaryName()}).`);
  }
  logger.info(`Installing bundled Phantom ${bundledVersion()} (${binaryName()})`);
  return installBinary(vendor, bundledVersion());
}

async function checkForUpdates({ download = true } = {}) {
  const currentTag = installedVersion() || bundledVersion();
  try {
    const response = await axios.get('https://api.github.com/repos/jhead/phantom/releases/latest', {
      headers: GITHUB_API_HEADERS,
      timeout: 20000,
    });
    const latestTag = response.data?.tag_name || response.data?.name;
    if (!latestTag) throw new Error('Phantom release is missing a version tag');
    if (latestTag === currentTag) {
      return { latestTag, currentTag, updated: false };
    }
    if (!download) {
      return { latestTag, currentTag, updated: false };
    }
    const asset = (response.data.assets || []).find(item => item.name === binaryName());
    const url = asset?.browser_download_url
      || `https://github.com/jhead/phantom/releases/download/${latestTag}/${binaryName()}`;
    logger.info(`Downloading Phantom ${latestTag} (${binaryName()})`);
    const file = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: GITHUB_DOWNLOAD_HEADERS,
      timeout: 120000,
      maxRedirects: 5,
    });
    const temp = path.join(BIN_DIR, `${binaryName()}.tmp`);
    fs.mkdirSync(BIN_DIR, { recursive: true });
    fs.writeFileSync(temp, Buffer.from(file.data));
    if (fs.statSync(temp).size < 1000) {
      fs.unlinkSync(temp);
      throw new Error('Downloaded Phantom binary was too small');
    }
    installBinary(temp, latestTag);
    try { fs.unlinkSync(temp); } catch { /* ignore */ }
    logger.info(`Updated Phantom from ${currentTag} to ${latestTag}`);
    return { latestTag, currentTag: latestTag, updated: true };
  } catch (err) {
    logger.warn(`Phantom update check failed: ${err.message}`);
    return { latestTag: null, currentTag, updated: false, error: err.message };
  }
}

function isActive(serverId) {
  const session = processes.get(Number(serverId));
  return Boolean(session && session.child && session.child.exitCode == null);
}

function hasAnyActive() {
  return [...processes.values()].some(item => item.child && item.child.exitCode == null);
}

function getError(serverId) {
  return lastErrors.get(Number(serverId)) || null;
}

function getProxyPort(serverId) {
  return processes.get(Number(serverId))?.proxyPort || null;
}

function usedProxyPorts() {
  return [...processes.values()].map(item => item.proxyPort).filter(Boolean);
}

function allocateProxyPort(preferred) {
  const taken = new Set(usedProxyPorts());
  if (preferred && !taken.has(Number(preferred)) && Number(preferred) >= PROXY_PORT_START && Number(preferred) <= PROXY_PORT_END) {
    return Number(preferred);
  }
  for (let port = PROXY_PORT_START; port <= PROXY_PORT_END; port += 1) {
    if (!taken.has(port)) return port;
  }
  throw new Error('No LAN proxy ports remain in 19200-19299');
}

function stop(serverId) {
  const key = Number(serverId);
  const session = processes.get(key);
  lastErrors.delete(key);
  if (!session) return;
  session.stopping = true;
  try { session.child.kill(); } catch { /* ignore */ }
  processes.delete(key);
}

function stopAll() {
  for (const id of [...processes.keys()]) stop(id);
}

function dedicatedServerTarget(server) {
  // Always target THIS host's Bedrock process. CONNECT_HOST is only a display
  // address for tiles and must not be used here (it may be DNS or another box).
  const lan = connectHost.detectLanIPv4();
  return `${lan || '127.0.0.1'}:${server.port}`;
}

function start(server, { proxyPort } = {}) {
  const key = Number(server.id);
  if (isActive(key)) return processes.get(key);
  lastErrors.delete(key);

  const bin = binaryPath();
  if (!fs.existsSync(bin)) {
    throw new Error('Phantom binary is not installed yet');
  }

  const port = allocateProxyPort(proxyPort || server.lan_proxy_port);
  const target = dedicatedServerTarget(server);
  logger.info(`Starting Phantom for ${server.name}: -server ${target} -bind 0.0.0.0 -bind_port ${port}`);
  const child = spawn(bin, [
    '-server', target,
    '-bind', '0.0.0.0',
    '-bind_port', String(port),
    '-timeout', '60',
    '-6',
  ], {
    cwd: BIN_DIR,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const session = { child, proxyPort: port, stopping: false };
  processes.set(key, session);

  const logLine = (stream) => (buf) => {
    String(buf).split(/\r?\n/).filter(Boolean).forEach((line) => {
      logger.info(`[phantom ${server.name}] ${line}`);
    });
  };
  child.stdout.on('data', logLine('stdout'));
  child.stderr.on('data', logLine('stderr'));
  child.on('exit', (code) => {
    processes.delete(key);
    if (!session.stopping) {
      const message = `LAN broadcast for ${server.name} stopped unexpectedly (code ${code}). UDP ${DISCOVERY_PORT} may already be in use.`;
      lastErrors.set(key, message);
      logger.warn(message);
    }
  });
  child.on('error', (err) => {
    processes.delete(key);
    lastErrors.set(key, err.message);
    logger.error(`Failed to start Phantom for ${server.name}: ${err.message}`);
  });

  return session;
}

async function startAndWait(server, options = {}) {
  ensureBinary();
  const session = start(server, options);
  await new Promise((resolve, reject) => {
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Phantom exited immediately (code ${code}). UDP ${DISCOVERY_PORT} is probably in use by Bedrock Connect or another process.`));
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, 1500);
    const cleanup = () => {
      clearTimeout(timer);
      session.child.removeListener('exit', onExit);
      session.child.removeListener('error', onError);
    };
    session.child.once('exit', onExit);
    session.child.once('error', onError);
  });
  return session;
}

function statusFor(server) {
  const id = Number(server.id);
  const native = server.kind !== 'bedrock_connect';
  const running = server.status === 'running' || server.status === 'starting';
  return {
    enabled: Number(server.lan_broadcast) === 1,
    active: native && running,
    native,
    proxyPort: server.lan_proxy_port || getProxyPort(id),
    error: getError(id),
    discoveryPort: DISCOVERY_PORT,
  };
}

module.exports = {
  DISCOVERY_PORT,
  PROXY_PORT_START,
  PROXY_PORT_END,
  allocateProxyPort,
  binaryPath,
  bundledVersion,
  checkForUpdates,
  ensureBinary,
  getError,
  getProxyPort,
  hasAnyActive,
  installedVersion,
  isActive,
  start,
  startAndWait,
  statusFor,
  stop,
  stopAll,
  usedProxyPorts,
};
