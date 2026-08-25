const MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';

function minecraftFromNeoForge(version) {
  const parts = String(version || '').split('.');
  if (parts.length < 2) return '';
  return `1.${parts[0]}.${parts[1]}`;
}

function createProvider(services) {
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
      const xml = await http.getText(`${MAVEN}/maven-metadata.xml`);
      return [...String(xml).matchAll(/<version>([^<]+)<\/version>/g)].map((item) => item[1]);
    },
    async listMinecraftVersions() {
      const versions = await this.listAllInstallerVersions();
      const seen = new Set();
      const out = [];
      for (const version of versions) {
        const mc = minecraftFromNeoForge(version);
        if (mc && !seen.has(mc)) {
          seen.add(mc);
          out.push(mc);
        }
      }
      return out;
    },
    async listLoaderVersions(minecraftVersion) {
      const versions = await this.listAllInstallerVersions();
      if (!minecraftVersion || minecraftVersion === 'latest') return versions.slice().reverse();
      return versions.filter((version) => minecraftFromNeoForge(version) === minecraftVersion);
    },
    async resolveInstallation(request) {
      const minecraftVersion = request.minecraftVersion || request.version || 'latest';
      const loaders = await this.listLoaderVersions(minecraftVersion === 'latest' ? '' : minecraftVersion);
      if (!loaders.length) {
        const err = new Error(`NeoForge is not available for Minecraft ${minecraftVersion}`);
        err.status = 400;
        throw err;
      }
      let loaderVersion = request.loaderVersion || 'latest-compatible';
      if (!loaderVersion || loaderVersion === 'latest-compatible' || loaderVersion === 'latest') {
        loaderVersion = loaders[loaders.length - 1];
      }
      if (!loaders.includes(loaderVersion)) {
        const err = new Error(`NeoForge ${loaderVersion} is not compatible with Minecraft ${minecraftVersion}`);
        err.status = 400;
        throw err;
      }
      const mc = minecraftFromNeoForge(loaderVersion);
      const major = Number(String(loaderVersion).split('.')[0]);
      return {
        loader: 'neoforge',
        minecraftVersion: mc,
        loaderVersion,
        javaMajor: major >= 21 ? 21 : 17,
      };
    },
    async planInstallation(request) {
      const resolved = await this.resolveInstallation(request);
      const file = `neoforge-${resolved.loaderVersion}-installer.jar`;
      return {
        downloads: [
          {
            url: `${MAVEN}/${encodeURIComponent(resolved.loaderVersion)}/${file}`,
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
          javaMajor: resolved.javaMajor,
          argFile: `libraries/net/neoforged/neoforge/${resolved.loaderVersion}/${process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt'}`,
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
      const argFile = meta.argFile || `libraries/net/neoforged/neoforge/${loaderVersion}/${process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt'}`;
      return {
        runtime: 'java',
        javaMajor: Number(server.java_major || 21),
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
      const mc = server.minecraft_version || server.version;
      const minecraftVersions = require('../../services/minecraftVersions');
      if (versions.length && mc && !minecraftVersions.supportsMinecraftVersion(versions, mc)) {
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
      return { loader: 'neoforge', minecraftVersion: server.minecraft_version, loaderVersion: server.loader_version };
    },
  };
}

module.exports = {
  createProvider,
  minecraftFromNeoForge,
  register({ registerJavaLoader, services }) {
    registerJavaLoader(createProvider(services));
  },
};
