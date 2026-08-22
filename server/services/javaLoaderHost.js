const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const pluginAudit = require('./pluginAudit');
const controlledDownload = require('./controlledDownload');
const controlledProcess = require('./controlledProcess');
const controlledFs = require('./controlledFs');
const javaRuntime = require('./javaRuntime');
const javaLoaderRegistry = require('./javaLoaderRegistry');
const { sanitizedChildEnv } = require('./childEnv');

const CACHE_DIR = path.join(__dirname, '../../data/java-edition/provider-cache');

function recordArtifact({ ownerType, ownerId, project, url, version, sha256, license }) {
  require('../db/connection').prepare(`
    INSERT INTO install_artifacts (owner_type, owner_id, project, download_url, version, sha256, license)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(ownerType || 'server', ownerId || 0, project || '', url || '', version || '', sha256 || '', license || '');
}

function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('Installation plan is invalid');
  }
  if (plan.command || plan.shell || typeof plan.arguments === 'string') {
    throw new Error('Providers must not return shell command strings');
  }
  const downloads = Array.isArray(plan.downloads) ? plan.downloads : [];
  for (const item of downloads) {
    if (!item?.url || !item?.destination) throw new Error('Each download needs a url and destination');
    controlledFs.assertRelative(item.destination);
  }
  if (plan.installer) {
    if (plan.installer.runtime && plan.installer.runtime !== 'java') {
      throw new Error('Only the Java runtime may run installers');
    }
    if (typeof plan.installer.command === 'string' || typeof plan.installer.arguments === 'string') {
      throw new Error('Installer command strings are not allowed');
    }
    controlledFs.assertRelative(plan.installer.jar);
    controlledProcess.assertArgArray(plan.installer.arguments || [], 'Installer');
  }
  return plan;
}

function validateLaunchSpec(spec, serverDir) {
  if (!spec || typeof spec !== 'object') throw new Error('Launch specification is invalid');
  if (spec.command || spec.shell || spec.cmd || typeof spec.arguments === 'string') {
    throw new Error('Launch specifications must use argument arrays, not shell commands');
  }
  if (spec.runtime && spec.runtime !== 'java') {
    throw new Error('Only the Java runtime is allowed');
  }
  const cwdRel = spec.workingDirectory && spec.workingDirectory !== '.'
    ? controlledFs.assertRelative(spec.workingDirectory)
    : '.';
  const cwd = cwdRel === '.' ? path.resolve(serverDir) : controlledFs.resolveInRoot(serverDir, cwdRel);
  if (spec.jar) controlledFs.assertRelative(spec.jar);
  const args = controlledProcess.assertArgArray(spec.arguments || [], 'Launch');
  const jvm = controlledProcess.assertArgArray(spec.jvmArguments || [], 'JVM');
  return { spec, cwd, args, jvm };
}

async function executeInstallPlan(plan, {
  serverDir,
  allowHosts,
  ownerId,
  fetcher,
} = {}) {
  const validated = validatePlan(plan);
  fs.mkdirSync(serverDir, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const downloaded = [];
  try {
    for (const item of validated.downloads || []) {
      const result = await controlledDownload.downloadIntoRoot(serverDir, item, {
        allowHosts,
        fetcher,
        project: item.project || validated.result?.loader,
        version: item.version || validated.result?.loaderVersion || validated.result?.minecraftVersion,
      });
      downloaded.push(result);
      recordArtifact({
        ownerType: 'server',
        ownerId,
        project: item.project || validated.result?.loader || '',
        url: item.url,
        version: item.version || validated.result?.loaderVersion || '',
        sha256: result.sha256,
        license: item.license || validated.result?.license || '',
      });
    }
    if (validated.installer) {
      const major = Number(validated.installer.javaMajor || validated.result?.javaMajor || 17);
      const javaBin = await javaRuntime.ensureJava({
        major,
        component: validated.installer.javaComponent,
      });
      await controlledProcess.runInstaller({
        serverDir,
        javaBin,
        jar: validated.installer.jar,
        arguments: validated.installer.arguments || [],
      });
    }
    return { plan: validated, downloaded };
  } catch (err) {
    logger.error(`Install plan failed: ${err.message}`);
    throw err;
  }
}

function memoryFlag(name, fallback) {
  const raw = String(process.env[name] || fallback).trim();
  return raw || fallback;
}

function buildJavaArgs(spec) {
  const args = [];
  const xms = spec.memory?.minimum || memoryFlag('MC_MANAGER_JAVA_XMS', '1G');
  const xmx = spec.memory?.maximum || memoryFlag('MC_MANAGER_JAVA_XMX', '2G');
  args.push(`-Xms${xms}`, `-Xmx${xmx}`);
  args.push(...controlledProcess.assertArgArray(spec.jvmArguments || [], 'JVM'));
  if (spec.jar) {
    args.push('-jar', spec.jar);
  }
  args.push(...controlledProcess.assertArgArray(spec.arguments || [], 'Launch'));
  return args;
}

async function resolveLaunch(server) {
  const loaderId = server.loader_provider_id || 'vanilla';
  const entry = javaLoaderRegistry.get(loaderId);
  if (!entry) {
    throw new Error(`Java loader "${loaderId}" is not available`);
  }
  const spec = entry.provider.getLaunchSpecification(server);
  const validated = validateLaunchSpec(spec, server.data_path);
  const javaBin = await javaRuntime.ensureJava({
    major: spec.javaMajor || server.java_major || 17,
    component: spec.javaComponent,
  });
  const args = buildJavaArgs(spec);
  const env = sanitizedChildEnv({
    ...(spec.environment || {}),
    JAVA_HOME: javaRuntime.javaHomeFromBin(javaBin),
  });
  pluginAudit.record('java.launch', {
    targetType: 'server',
    targetId: String(server.id),
    detail: { loader: loaderId, javaBin, args },
  });
  return {
    javaBin,
    args,
    cwd: validated.cwd,
    env,
    spec,
  };
}

module.exports = {
  CACHE_DIR,
  buildJavaArgs,
  executeInstallPlan,
  recordArtifact,
  resolveLaunch,
  validateLaunchSpec,
  validatePlan,
};
