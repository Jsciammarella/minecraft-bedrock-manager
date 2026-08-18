const fs = require('fs');
const path = require('path');
const net = require('net');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const isWindows = process.platform === 'win32';

const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function bedrockBinaryName() {
  return isWindows ? 'bedrock_server.exe' : 'bedrock_server';
}

function bedrockBinaryPath(serverDir) {
  if (!isWindows) return path.join(serverDir, 'bedrock_server');
  const exe = path.join(serverDir, 'bedrock_server.exe');
  if (fs.existsSync(exe)) return exe;
  const cmd = path.join(serverDir, 'bedrock_server.cmd');
  if (fs.existsSync(cmd)) return cmd;
  return exe;
}

function bedrockDownloadNeedles() {
  if (isWindows) {
    return {
      userAgent: WINDOWS_UA,
      typeRe: /serverBedrockWindows/i,
      urlRe: /bin-win(?:-x64)?/i,
      pageRe: /https:\/\/www\.minecraft\.net\/bedrockdedicatedserver\/bin-win(?:-x64)?\/bedrock-server-[0-9.]+\.zip/g,
    };
  }
  return {
    userAgent: LINUX_UA,
    typeRe: /serverBedrockLinux/i,
    urlRe: /bin-linux/i,
    pageRe: /https:\/\/www\.minecraft\.net\/bedrockdedicatedserver\/bin-linux\/bedrock-server-[0-9.]+\.zip/g,
  };
}

function chmodIfNeeded(filePath, mode = 0o755) {
  if (isWindows) return;
  try { fs.chmodSync(filePath, mode); } catch { /* ignore */ }
}

function bedrockSpawnEnv(serverPath, port) {
  const env = { ...process.env, PORT: String(port) };
  if (!isWindows) env.LD_LIBRARY_PATH = `${serverPath}:.`;
  return env;
}

function bedrockSpawn(serverBin) {
  if (isWindows && /\.cmd$/i.test(serverBin)) {
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/c', serverBin] };
  }
  return { file: serverBin, args: [] };
}

function firstExisting(candidates) {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || '';
}

function javaCommand() {
  const fromEnv = firstExisting([
    process.env.MC_MANAGER_JAVA,
    process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, 'bin', isWindows ? 'java.exe' : 'java'),
  ]);
  if (fromEnv) return fromEnv;
  return isWindows ? 'java.exe' : 'java';
}

function pythonBins() {
  const extra = process.env.MC_MANAGER_PYTHON;
  const defaults = isWindows ? ['python', 'python3', 'py'] : ['python3', 'python'];
  return extra ? [extra, ...defaults] : defaults;
}

function gitCommand() {
  const fromEnv = process.env.MC_MANAGER_GIT;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  return 'git';
}

function windowsTar() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
}

async function unzipArchive(zipPath, destDir) {
  if (!isWindows) {
    throw new Error('unzipArchive is only used on Windows; Linux keeps unzip(1)');
  }
  fs.mkdirSync(destDir, { recursive: true });
  try {
    await execFileAsync(windowsTar(), ['-xf', zipPath, '-C', destDir], {
      timeout: 180000,
      windowsHide: true,
    });
    return;
  } catch (tarErr) {
    const python = pythonBins().find((bin) => bin);
    if (!python) throw tarErr;
    const script = [
      'import os, sys, zipfile',
      'src, dest = sys.argv[1], sys.argv[2]',
      'dest = os.path.abspath(dest)',
      'os.makedirs(dest, exist_ok=True)',
      'archive = zipfile.ZipFile(src)',
      'archive.extractall(dest)',
    ].join('\n');
    await execFileAsync(python, ['-c', script, zipPath, destDir], {
      timeout: 180000,
      windowsHide: true,
    });
  }
}

async function listZipEntries(zipPath) {
  const { stdout } = await execFileAsync(windowsTar(), ['-tf', zipPath], {
    timeout: 60000,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  return String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\\/g, '/').trim())
    .filter(Boolean);
}

async function extractZipEntryToBuffer(zipPath, entry) {
  const { stdout } = await execFileAsync(windowsTar(), ['-xOf', zipPath, entry], {
    encoding: null,
    timeout: 60000,
    windowsHide: true,
    maxBuffer: 6 * 1024 * 1024,
  });
  if (!stdout || !stdout.length) throw new Error(`No data for ${entry}`);
  return stdout;
}

function copyDirSync(src, dst) {
  fs.cpSync(src, dst, { recursive: true });
}

function detectArchName() {
  if (isWindows) return process.arch === 'arm64' ? 'arm64' : 'x86_64';
  return '';
}

function pingHost(host, timeoutMs = 2000) {
  const target = String(host || '').trim();
  if (!target || target.startsWith('-')) return Promise.resolve(false);
  const timeoutMsClamped = Math.max(1000, Number(timeoutMs) || 2000);
  const timeoutSec = Math.max(1, Math.ceil(timeoutMsClamped / 1000));
  const family = net.isIP(target);
  const args = isWindows
    ? ['-n', '1', '-w', String(timeoutMsClamped), ...(family === 6 ? ['-6'] : []), target]
    : ['-c', '1', '-W', String(timeoutSec), ...(family === 6 ? ['-6'] : []), target];
  return execFileAsync('ping', args, {
    timeout: timeoutMsClamped + 1500,
    windowsHide: true,
  }).then(() => true).catch(() => false);
}

module.exports = {
  LINUX_UA,
  WINDOWS_UA,
  bedrockBinaryName,
  bedrockBinaryPath,
  bedrockDownloadNeedles,
  bedrockSpawn,
  bedrockSpawnEnv,
  chmodIfNeeded,
  copyDirSync,
  detectArchName,
  gitCommand,
  isWindows,
  javaCommand,
  pingHost,
  pythonBins,
  unzipArchive,
  listZipEntries,
  extractZipEntryToBuffer,
};
