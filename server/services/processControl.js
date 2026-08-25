const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const logger = require('./logger');

const execFileAsync = promisify(execFile);
const DISCOVERY_IPV4 = 19132;
const DISCOVERY_IPV6 = 19133;

const defaults = {
  platform: process.platform,
  kill: (pid, signal) => process.kill(pid, signal),
  execFile: execFileAsync,
  readFileSync: (...args) => fs.readFileSync(...args),
  readdirSync: (...args) => fs.readdirSync(...args),
  readlinkSync: (...args) => fs.readlinkSync(...args),
  existsSync: (...args) => fs.existsSync(...args),
};

let impl = { ...defaults };
const commandLog = [];

function configure(overrides = {}) {
  impl = { ...defaults, ...overrides };
}

function reset() {
  impl = { ...defaults };
  commandLog.length = 0;
}

function recordedCommands() {
  return commandLog.slice();
}

function record(entry) {
  commandLog.push(entry);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePid(pid) {
  const value = Number(pid);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function isPidAlive(pid) {
  const value = normalizePid(pid);
  if (!value) return false;
  try {
    impl.kill(value, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'EPERM') return true;
    return false;
  }
}

async function waitForPidExit(pid, timeoutMs, intervalMs = 50) {
  const value = normalizePid(pid);
  if (!value) return true;
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() < deadline) {
    if (!isPidAlive(value)) return true;
    await sleep(intervalMs);
  }
  return !isPidAlive(value);
}

function linuxIdentity(pid) {
  const cmdline = String(impl.readFileSync(`/proc/${pid}/cmdline`, 'utf8') || '').replace(/\0/g, ' ').trim();
  let exe = '';
  let cwd = '';
  try { exe = String(impl.readlinkSync(`/proc/${pid}/exe`) || ''); } catch { /* ignore */ }
  try { cwd = String(impl.readlinkSync(`/proc/${pid}/cwd`) || ''); } catch { /* ignore */ }
  return { pid: Number(pid), cmdline, exe, cwd };
}

async function windowsIdentity(pid) {
  const identity = { pid: Number(pid), cmdline: '', exe: '' };
  try {
    const { stdout } = await impl.execFile('tasklist', [
      '/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH',
    ], { timeout: 5000, windowsHide: true });
    record({ file: 'tasklist', args: ['/FI', `PID eq ${pid}`] });
    const line = String(stdout || '').trim();
    if (!line || /No tasks/i.test(line)) return null;
    const cols = line.split(',').map((item) => item.replace(/^"|"$/g, ''));
    identity.exe = cols[0] || '';
  } catch {
    return identity;
  }
  try {
    const { stdout } = await impl.execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -ExpandProperty CommandLine`,
    ], { timeout: 5000, windowsHide: true });
    identity.cmdline = String(stdout || '').trim();
  } catch { /* command line is optional; PID + session token remain authoritative */ }
  return identity;
}

async function processIdentity(pid) {
  const value = normalizePid(pid);
  if (!value) return null;
  try {
    if (impl.platform === 'win32') return await windowsIdentity(value);
    return linuxIdentity(value);
  } catch {
    return null;
  }
}

function identityMatches(identity, expected = {}) {
  if (!identity || !expected) return false;
  if (normalizePid(identity.pid) !== normalizePid(expected.pid)) return false;
  const haystack = `${identity.cmdline || ''} ${identity.exe || ''}`.replace(/\\/g, '/').toLowerCase();
  if (expected.jarPath) {
    const jar = String(expected.jarPath).replace(/\\/g, '/').toLowerCase();
    const base = path.basename(expected.jarPath).toLowerCase();
    if (!haystack.includes(jar) && !haystack.includes(base)) return false;
  }
  for (const needle of expected.mustInclude || []) {
    if (!haystack.includes(String(needle).replace(/\\/g, '/').toLowerCase())) return false;
  }
  return true;
}

function linuxChildPids(pid) {
  const parent = normalizePid(pid);
  const children = [];
  try {
    const raw = impl.readFileSync(`/proc/${parent}/task/${parent}/children`, 'utf8');
    for (const part of String(raw || '').trim().split(/\s+/)) {
      const child = normalizePid(part);
      if (child) children.push(child);
    }
    if (children.length) return children;
  } catch { /* some kernels omit this file */ }

  let entries = [];
  try { entries = impl.readdirSync('/proc'); } catch { return children; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const child = Number(entry);
    if (child === parent) continue;
    try {
      const stat = String(impl.readFileSync(`/proc/${child}/stat`, 'utf8') || '');
      const close = stat.lastIndexOf(')');
      if (close < 0) continue;
      const rest = stat.slice(close + 2).split(/\s+/);
      const ppid = Number(rest[1]);
      if (ppid === parent) children.push(child);
    } catch { /* process exited */ }
  }
  return children;
}

function parseProcNetInodes(content, port) {
  const hexPort = Number(port).toString(16).padStart(4, '0').toLowerCase();
  const inodes = new Set();
  for (const line of String(content || '').split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10) continue;
    const local = cols[1] || '';
    const colon = local.lastIndexOf(':');
    if (colon < 0) continue;
    if (local.slice(colon + 1).toLowerCase() !== hexPort) continue;
    inodes.add(String(cols[9]));
  }
  return inodes;
}

function linuxUdpInodes(port) {
  const inodes = new Set();
  for (const file of ['/proc/net/udp', '/proc/net/udp6']) {
    try {
      for (const inode of parseProcNetInodes(impl.readFileSync(file, 'utf8'), port)) {
        inodes.add(inode);
      }
    } catch { /* /proc/net may be restricted */ }
  }
  return inodes;
}

function pidHasSocketInodes(pid, inodes) {
  if (!inodes.size) return false;
  const fdDir = `/proc/${pid}/fd`;
  let fds;
  try { fds = impl.readdirSync(fdDir); } catch { return false; }
  for (const fd of fds) {
    try {
      const target = String(impl.readlinkSync(path.join(fdDir, String(fd))) || '');
      const match = /^socket:\[(\d+)\]$/.exec(target);
      if (match && inodes.has(match[1])) return true;
    } catch { /* fd raced */ }
  }
  return false;
}

function linuxPidOwnsUdp(pid, port) {
  const inodes = linuxUdpInodes(port);
  if (!inodes.size) return null;
  const value = normalizePid(pid);
  if (pidHasSocketInodes(value, inodes)) return true;
  for (const child of linuxChildPids(value)) {
    if (pidHasSocketInodes(child, inodes)) return true;
  }
  return false;
}

function parseWindowsNetstatPids(stdout, port) {
  const suffix = `:${Number(port)}`;
  const pids = new Set();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!/^\s*UDP/i.test(line)) continue;
    const parts = line.trim().split(/\s+/);
    const local = parts[1] || '';
    if (!local.endsWith(suffix) && !local.endsWith(`]${suffix}`)) continue;
    const pid = normalizePid(parts[parts.length - 1]);
    if (pid) pids.add(pid);
  }
  return [...pids];
}

async function windowsUdpOwnerPids(port) {
  try {
    const { stdout } = await impl.execFile('netstat', ['-ano', '-p', 'UDP'], {
      timeout: 5000,
      windowsHide: true,
    });
    record({ file: 'netstat', args: ['-ano', '-p', 'UDP'] });
    return parseWindowsNetstatPids(stdout, port);
  } catch {
    return [];
  }
}

function linuxUdpOwnerPids(port) {
  const inodes = linuxUdpInodes(port);
  if (!inodes.size) return [];
  const pids = [];
  let entries = [];
  try { entries = impl.readdirSync('/proc'); } catch { return pids; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pidHasSocketInodes(pid, inodes)) pids.push(pid);
  }
  return pids;
}

async function udpOwnerPids(port) {
  if (impl.platform === 'win32') return windowsUdpOwnerPids(port);
  return linuxUdpOwnerPids(port);
}

async function pidOwnsUdpPort(pid, port) {
  const value = normalizePid(pid);
  if (!value) return false;
  if (impl.platform === 'win32') {
    const owners = await windowsUdpOwnerPids(port);
    if (!owners.length) return null;
    return owners.includes(value);
  }
  return linuxPidOwnsUdp(value, port);
}

function taskkillPath() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
}

async function windowsKillTree(pid, force) {
  const file = taskkillPath();
  const args = ['/PID', String(pid), '/T'];
  if (force) args.push('/F');
  record({ file: 'taskkill', args: args.slice() });
  try {
    await impl.execFile(file, args, { timeout: 15000, windowsHide: true });
  } catch (err) {
    const text = `${err.stderr || ''} ${err.stdout || ''} ${err.message || ''}`;
    if (/not found/i.test(text)) return;
    throw err;
  }
}

function signalPid(pid, signal) {
  const value = normalizePid(pid);
  if (!value) return;
  record({ type: 'kill', pid: value, signal: signal || 'SIGTERM' });
  try {
    impl.kill(value, signal || 'SIGTERM');
  } catch { /* already gone */ }
}

async function assertSafeToKill(pid, expected) {
  const value = normalizePid(pid);
  if (!value) throw new Error('Refusing to terminate an invalid PID');
  if (!isPidAlive(value)) return false;
  if (expected && Number(expected.pid) && Number(expected.pid) !== value) {
    throw new Error(`Refusing to terminate PID ${value}: it is not the tracked BedrockConnect PID ${expected.pid}`);
  }
  const identity = await processIdentity(value);
  if (identity && expected && (expected.jarPath || (expected.mustInclude || []).length)) {
    if (!identityMatches(identity, { ...expected, pid: value })) {
      throw new Error(
        `Refusing to terminate PID ${value}: process identity does not match tracked BedrockConnect`
      );
    }
  }
  return true;
}

async function terminateProcessTree({
  pid,
  identity = {},
  gracefulMs = 8000,
  forceMs = 5000,
  verify = true,
} = {}) {
  const value = normalizePid(pid);
  if (!value) return { ok: true, method: 'already-dead' };
  if (!isPidAlive(value)) return { ok: true, method: 'already-dead' };

  if (verify) {
    const allowed = await assertSafeToKill(value, { pid: value, ...identity });
    if (!allowed) return { ok: true, method: 'already-dead' };
  }

  logger.info('Bedrock Connect PID receiving graceful termination', { pid: value });
  if (impl.platform === 'win32') {
    await windowsKillTree(value, false);
  } else {
    for (const child of linuxChildPids(value)) signalPid(child, 'SIGTERM');
    signalPid(value, 'SIGTERM');
  }

  if (await waitForPidExit(value, gracefulMs)) {
    logger.info('Confirmed process exit', { pid: value });
    return { ok: true, method: 'graceful' };
  }

  logger.warn('Graceful termination timeout', { pid: value });
  logger.warn('Forced termination', { pid: value, platform: impl.platform });
  if (impl.platform === 'win32') {
    await windowsKillTree(value, true);
  } else {
    for (const child of linuxChildPids(value)) signalPid(child, 'SIGKILL');
    signalPid(value, 'SIGKILL');
  }

  const gone = await waitForPidExit(value, forceMs);
  if (!gone) {
    logger.error('Bedrock Connect process remained active after forced termination', { pid: value });
    return { ok: false, method: 'force-failed', pid: value };
  }
  logger.info('Confirmed process exit', { pid: value });
  return { ok: true, method: 'forced' };
}

function isOurBedrockConnectIdentity(identity, jarPath) {
  if (!identity) return false;
  const haystack = `${identity.cmdline || ''} ${identity.exe || ''}`.replace(/\\/g, '/').toLowerCase();
  if (!/bedrockconnect/i.test(haystack) && !haystack.includes('bedrock-connect')) return false;
  if (jarPath) {
    const jar = String(jarPath).replace(/\\/g, '/').toLowerCase();
    const base = path.basename(jarPath).toLowerCase();
    if (!haystack.includes(jar) && !haystack.includes(base)) return false;
  }
  return true;
}

module.exports = {
  DISCOVERY_IPV4,
  DISCOVERY_IPV6,
  assertSafeToKill,
  configure,
  identityMatches,
  isOurBedrockConnectIdentity,
  isPidAlive,
  linuxChildPids,
  parseProcNetInodes,
  parseWindowsNetstatPids,
  pidOwnsUdpPort,
  processIdentity,
  recordedCommands,
  reset,
  signalPid,
  terminateProcessTree,
  udpOwnerPids,
  waitForPidExit,
};
