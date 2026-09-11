'use strict';

const mapping = require('./versionMapping');
const catalog = require('./versionCatalog');
const recordRepair = require('./recordRepair');

function createProvider(services = {}) {
  const http = services.http;
  return {
    getMetadata() {
      return {
        id: 'neoforge',
        name: 'NeoForge',
        supportsMods: true,
        downloadHosts: ['maven.neoforged.net'],
        notices: ['Compatible with NeoForge. Not affiliated with or endorsed by NeoForged.'],
      };
    },
    async listAllInstallerVersions() {
      const loaded = await catalog.loadCatalog(http, services, { refresh: true });
      return loaded.versions.map((item) => item.loaderVersion);
    },
    async listMinecraftVersions() {
      return catalog.listMinecraftVersions(http, services);
    },
    async listLoaderVersions(minecraftVersion) {
      return catalog.listLoaderVersions(http, services, minecraftVersion);
    },
    async resolveInstallation(request) {
      return catalog.resolveMappedInstallation(http, services, request || {});
    },
    async planInstallation(request) {
      const resolved = await this.resolveInstallation(request);
      const file = catalog.installerFileName(resolved.loaderVersion);
      return {
        downloads: [
          {
            url: catalog.installerUrl(resolved.loaderVersion),
            destination: `installer/${file}`,
            maximumBytes: 12000000,
            project: 'NeoForge',
            version: resolved.loaderVersion,
            license: 'LGPL',
          },
        ],
        installer: {
          runtime: 'java',
          javaMajor: resolved.javaMajor,
          jar: `installer/${file}`,
          arguments: ['--installServer'],
        },
        result: {
          loader: 'neoforge',
          minecraftVersion: resolved.minecraftVersion,
          loaderVersion: resolved.loaderVersion,
          loaderChannel: resolved.loaderChannel,
          javaMajor: resolved.javaMajor,
          argFile: catalog.argFileRelative(resolved.loaderVersion),
          license: 'LGPL',
        },
      };
    },
    async planUpdate(server, request) {
      return this.planInstallation({
        minecraftVersion: request?.minecraftVersion || server.minecraft_version,
        loaderVersion: request?.loaderVersion || 'latest-compatible',
      });
    },
    getLaunchSpecification(server) {
      let meta = {};
      try { meta = server.loader_metadata ? JSON.parse(server.loader_metadata) : {}; } catch { meta = {}; }
      const loaderVersion = server.loader_version || meta.loaderVersion;
      const argFile = meta.argFile || catalog.argFileRelative(loaderVersion);
      return {
        runtime: 'java',
        javaMajor: Number(server.java_major || mapping.recommendedJavaMajor(server.minecraft_version, loaderVersion)),
        workingDirectory: '.',
        arguments: [`@${argFile}`, 'nogui'],
        memory: {
          minimum: String(process.env.MC_MANAGER_JAVA_XMS || '1G'),
          maximum: String(process.env.MC_MANAGER_JAVA_XMX || '2G'),
        },
        environment: {},
      };
    },
    getModSupport() {
      return { supportsMods: true, modsDirectory: 'mods', loaders: ['neoforge'] };
    },
    validateMod(server, artifact) {
      const loader = String(artifact.loader || '').toLowerCase();
      if (loader && loader !== 'neoforge' && loader !== 'forge' && loader !== 'any') {
        return { ok: false, error: 'This mod is not built for NeoForge' };
      }
      const versions = artifact.minecraftVersions || [];
      const mc = server.minecraft_version || server.minecraftVersion || server.version;
      const javaModMetadata = require('../../services/javaModMetadata');
      const rangeCheck = javaModMetadata.evaluateMinecraftRequirement(mc, { ...artifact, loader: 'neoforge' });
      if (rangeCheck && !rangeCheck.compatible) {
        return { ok: false, error: rangeCheck.reason || `This mod does not list Minecraft ${mc}` };
      }
      const minecraftVersions = require('../../services/minecraftVersions');
      if (!rangeCheck && versions.length && mc && !minecraftVersions.supportsMinecraftVersion(versions, mc)) {
        return { ok: false, error: `This mod does not list Minecraft ${mc}` };
      }
      const warnings = [];
      if (artifact.environment === 'client') warnings.push('This looks like a client-only mod. A matching client install may also be required.');
      if (artifact.sourceType === 'upload') warnings.push('Uploaded Java mods are executable code. Only install mods you trust.');
      return { ok: true, warnings };
    },
    getBackupPaths() {
      return ['world', 'world_nether', 'world_the_end', 'logs', 'mods', 'config', 'eula.txt', 'server.properties'];
    },
    getHealthInformation(server) {
      return {
        loader: 'neoforge',
        minecraftVersion: server.minecraft_version || server.minecraftVersion,
        loaderVersion: server.loader_version,
      };
    },
    inspectInstalledMinecraft(serverDir, server) {
      return mapping.inspectInstalledMinecraft(serverDir, server);
    },
    repairPersistedRecords(options) {
      return recordRepair.repairPersistedRecords(options);
    },
  };
}

module.exports = {
  createProvider,
  minecraftFromNeoForge: mapping.minecraftFromNeoForge,
  parseNeoForgeArtifact: mapping.parseNeoForgeArtifact,
  register({ registerJavaLoader, services }) {
    registerJavaLoader(createProvider(services));
  },
};
