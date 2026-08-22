const META = 'https://meta.fabricmc.net';

function createProvider(services) {
  const http = services.http;
  return {
    getMetadata() {
      return {
        id: 'fabric',
        name: 'Fabric',
        supportsMods: true,
        downloadHosts: ['meta.fabricmc.net', 'maven.fabricmc.net'],
        notices: ['Compatible with Fabric. Not affiliated with or endorsed by FabricMC.'],
      };
    },
    async listMinecraftVersions() {
      const data = await http.getJson(`${META}/v2/versions/game`);
      return (Array.isArray(data) ? data : []).filter((item) => item.stable).map((item) => item.version);
    },
    async listLoaderVersions(minecraftVersion) {
      let mc = minecraftVersion;
      if (!mc || mc === 'latest') {
        const games = await this.listMinecraftVersions();
        mc = games[0];
      }
      if (!mc) return [];
      const data = await http.getJson(`${META}/v2/versions/loader/${encodeURIComponent(mc)}`);
      return (Array.isArray(data) ? data : []).map((item) => item.loader?.version).filter(Boolean);
    },
    async resolveInstallation(request) {
      const minecraftVersion = request.minecraftVersion || request.version || 'latest';
      const games = await this.listMinecraftVersions();
      const mc = minecraftVersion === 'latest' ? games[0] : minecraftVersion;
      if (!games.includes(mc) && minecraftVersion !== 'latest') {
        const err = new Error(`Fabric is not available for Minecraft ${mc}`);
        err.status = 400;
        throw err;
      }
      const loaders = await this.listLoaderVersions(mc);
      let loaderVersion = request.loaderVersion || 'latest-compatible';
      if (!loaderVersion || loaderVersion === 'latest-compatible' || loaderVersion === 'latest') {
        loaderVersion = loaders[0];
      }
      if (!loaders.includes(loaderVersion)) {
        const err = new Error(`Fabric loader ${loaderVersion} is not compatible with Minecraft ${mc}`);
        err.status = 400;
        throw err;
      }
      const installers = await http.getJson(`${META}/v2/versions/installer`);
      const installer = (Array.isArray(installers) ? installers : []).find((item) => item.stable) || installers[0];
      return {
        loader: 'fabric',
        minecraftVersion: mc,
        loaderVersion,
        installerVersion: installer?.version,
        javaMajor: 21,
      };
    },
    async planInstallation(request) {
      const resolved = await this.resolveInstallation(request);
      const url = `${META}/v2/versions/loader/${encodeURIComponent(resolved.minecraftVersion)}/${encodeURIComponent(resolved.loaderVersion)}/${encodeURIComponent(resolved.installerVersion)}/server/jar`;
      return {
        downloads: [
          {
            url,
            destination: 'server.jar',
            maximumBytes: 80000000,
            project: 'Fabric',
            version: `${resolved.minecraftVersion}/${resolved.loaderVersion}`,
            license: 'Apache-2.0 / Fabric',
          },
        ],
        result: {
          loader: 'fabric',
          minecraftVersion: resolved.minecraftVersion,
          loaderVersion: resolved.loaderVersion,
          javaMajor: resolved.javaMajor,
          launchJar: 'server.jar',
          license: 'Apache-2.0',
        },
      };
    },
    async planUpdate(server, request) {
      return this.planInstallation({
        minecraftVersion: request?.minecraftVersion || server.minecraft_version,
        loaderVersion: request?.loaderVersion || server.loader_version || 'latest-compatible',
      });
    },
    getLaunchSpecification(server) {
      return {
        runtime: 'java',
        javaMajor: Number(server.java_major || 21),
        workingDirectory: '.',
        jar: 'server.jar',
        arguments: ['nogui'],
        memory: {
          minimum: String(process.env.MC_MANAGER_JAVA_XMS || '1G'),
          maximum: String(process.env.MC_MANAGER_JAVA_XMX || '2G'),
        },
        environment: {},
      };
    },
    getModSupport() {
      return { supportsMods: true, modsDirectory: 'mods', loaders: ['fabric'] };
    },
    validateMod(server, artifact) {
      const loader = String(artifact.loader || '').toLowerCase();
      if (loader && loader !== 'fabric' && loader !== 'any') {
        return { ok: false, error: 'This mod is not built for Fabric' };
      }
      const versions = artifact.minecraftVersions || [];
      const mc = server.minecraft_version || server.version;
      if (versions.length && mc && !versions.includes(mc) && !versions.includes('any')) {
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
      return { loader: 'fabric', minecraftVersion: server.minecraft_version, loaderVersion: server.loader_version };
    },
  };
}

module.exports = {
  createProvider,
  register({ registerJavaLoader, services }) {
    registerJavaLoader(createProvider(services));
  },
};
