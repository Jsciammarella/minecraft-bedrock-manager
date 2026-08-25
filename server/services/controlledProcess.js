const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const { sanitizedChildEnv } = require('./childEnv');
const javaRuntime = require('./javaRuntime');
const controlledFs = require('./controlledFs');

const running = new Map();
let seq = 1;

function assertArgArray(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw Object.assign(new Error(`${label} must be an argument array, not a shell string`), { status: 400 });
  }
  return value.map((item) => {
    if (item == null) return '';
    if (typeof item === 'object') {
      throw Object.assign(new Error(`${label} arguments must be strings`), { status: 400 });
    }
    return String(item);
  });
}

function assertApprovedJava(javaBin, approved) {
  const resolved = path.resolve(javaBin);
  const allowed = (approved || []).map((item) => path.resolve(item));
  if (!allowed.includes(resolved)) {
    throw Object.assign(new Error('Java executable is not on the approved runtime list'), { status: 400 });
  }
  return resolved;
}

function runJava({
  javaBin,
  args = [],
  cwd,
  extraEnv = {},
  timeoutMs = 180000,
  stdin,
} = {}) {
  const argv = assertArgArray(args, 'Java');
  if (argv.some((item) => item === '/c' || item === '-c' || item === 'cmd.exe' || item === 'sh' || item === 'bash')) {
    throw Object.assign(new Error('Shell command strings are not allowed'), { status: 400 });
  }
  const env = sanitizedChildEnv({
    ...extraEnv,
    JAVA_HOME: path.isAbsolute(javaBin) ? javaRuntime.javaHomeFromBin(javaBin) : extraEnv.JAVA_HOME,
  });
  return new Promise((resolve, reject) => {
    const child = spawn(javaBin, argv, {
      cwd,
      env,
      windowsHide: true,
      shell: false,
    });
    const id = `proc-${seq}`;
    seq += 1;
    running.set(id, child);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error(`Java process timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (err) => {
      clearTimeout(timer);
      running.delete(id);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      running.delete(id);
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(new Error(`Java process exited ${code}: ${stderr || stdout}`));
    });
    if (stdin) child.stdin.end(String(stdin));
  });
}

function stopAll() {
  for (const child of running.values()) {
    try { child.kill(); } catch { /* ignore */ }
  }
  running.clear();
}

async function runInstaller({ serverDir, javaBin, jar, arguments: installerArgs, timeoutMs }) {
  const relJar = controlledFs.assertRelative(jar);
  const jarPath = controlledFs.resolveInRoot(serverDir, relJar);
  if (!fs.existsSync(jarPath)) {
    throw new Error(`Installer jar was not found: ${relJar}`);
  }
  const args = ['-jar', jarPath, ...assertArgArray(installerArgs, 'Installer')];
  logger.info(`Running Java installer ${relJar}`);
  return runJava({
    javaBin,
    args,
    cwd: serverDir,
    timeoutMs: timeoutMs || 300000,
  });
}

module.exports = {
  assertApprovedJava,
  assertArgArray,
  runInstaller,
  runJava,
  stopAll,
};
