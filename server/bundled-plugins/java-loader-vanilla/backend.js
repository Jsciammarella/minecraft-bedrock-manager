const javaEdition = require('../../services/javaEdition');

function createProvider() {
  return {
    getMetadata() {
      return {
        id: 'vanilla',
        name: 'Vanilla',
        supportsMods: false,
        downloadHosts: [
          'piston-meta.mojang.com',
          'piston-data.mojang.com',
          'launcher.mojang.com',
          'launchermeta.mojang.com',
        ],
        notices: ['Uses the official Minecraft Java Edition dedicated server.jar from Mojang.'],
      };
    },
    async listMinecraftVersions() {
      const listed = await javaEdition.listReleaseVersions();
      return listed.versions || [];
    },
    async listLoaderVersions() {
      return ['vanilla'];
    },
    async resolveInstallation(request) {
      const resolved = await javaEdition.resolveRelease(request.minecraftVersion || request.version || 'latest');
      return {
        loader: 'vanilla',
        minecraftVersion: resolved.id,
        loaderVersion: 'vanilla',
        javaMajor: resolved.javaMajor,
        javaComponent: resolved.javaComponent,
      };
    },
    async planInstallation(request) {
      const resolved = await javaEdition.resolveRelease(request.minecraftVersion || request.version || 'latest');
      return {
        downloads: [
          {
            url: resolved.url,
            destination: 'server.jar',
            sha1: resolved.sha1,
            maximumBytes: 80000000,
            project: 'Minecraft Java Edition',
            version: resolved.id,
            license: 'Minecraft EULA',
          },
        ],
        result: {
          loader: 'vanilla',
          minecraftVersion: resolved.id,
          loaderVersion: 'vanilla',
          javaMajor: resolved.javaMajor,
          javaComponent: resolved.javaComponent,
          launchJar: 'server.jar',
          license: 'Minecraft EULA',
        },
      };
    },
    async planUpdate(server, request) {
      return this.planInstallation({
        minecraftVersion: request?.minecraftVersion || request?.version || server.minecraft_version || server.version,
      });
    },
    getLaunchSpecification(server) {
      let meta = {};
      try { meta = server.loader_metadata ? JSON.parse(server.loader_metadata) : {}; } catch { meta = {}; }
      return {
        runtime: 'java',
        javaMajor: Number(server.java_major || meta.javaMajor || 17),
        javaComponent: meta.javaComponent,
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
      return { supportsMods: false, modsDirectory: 'mods', loaders: ['vanilla'] };
    },
    validateMod() {
      return { ok: false, error: 'Vanilla Java servers do not support Fabric or NeoForge mods' };
    },
    getBackupPaths() {
      return javaEdition.worldBackupDirs().concat(javaEdition.accessBackupFiles());
    },
    getHealthInformation(server) {
      return { loader: 'vanilla', minecraftVersion: server.minecraft_version || server.version };
    },
  };
}

module.exports = {
  createProvider,
  register({ registerJavaLoader }) {
    registerJavaLoader(createProvider());
  },
};
