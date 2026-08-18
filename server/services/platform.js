const fs = require('fs');
const path = require('path');
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

function psSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function unzipArchive(zipPath, destDir) {
  if (!isWindows) {
    throw new Error('unzipArchive is only used on Windows; Linux keeps unzip(1)');
  }
  await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-Command',
    `Expand-Archive -LiteralPath ${psSingleQuote(zipPath)} -DestinationPath ${psSingleQuote(destDir)} -Force`,
  ], { timeout: 120000, windowsHide: true });
}

function copyDirSync(src, dst) {
  fs.cpSync(src, dst, { recursive: true });
}

function detectArchName() {
  if (isWindows) return process.arch === 'arm64' ? 'arm64' : 'x86_64';
  return '';
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
  pythonBins,
  unzipArchive,
};
