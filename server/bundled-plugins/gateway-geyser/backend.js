const DOWNLOAD = 'https://download.geysermc.org/v2/projects/geyser/versions/latest/builds/latest/downloads/standalone';
const FABRIC_DOWNLOAD = 'https://download.geysermc.org/v2/projects/geyser/versions/latest/builds/latest/downloads/fabric';
const NEOFORGE_DOWNLOAD = 'https://download.geysermc.org/v2/projects/geyser/versions/latest/builds/latest/downloads/neoforge';

function yamlEscape(value) {
  return String(value ?? '').replace(/"/g, '\\"');
}

function sendError(res, err) {
  res.status(err.status || 400).json({ error: err.message, code: err.code });
}

function createProvider() {
  return {
    getMetadata() {
      return {
        id: 'geyser',
        name: 'Geyser',
        recommended: true,
        targetKinds: ['java'],
        supportsCreateForTarget: true,
        managementPage: 'home',
        downloadHosts: ['download.geysermc.org', 'repo.opencollab.dev'],
        notices: [
          'Powered by Geyser. Not affiliated with or endorsed by GeyserMC, Mojang, or Microsoft.',
          'Standalone is recommended for remote Java servers and older Minecraft versions.',
          'Geyser-Fabric and Geyser-NeoForge support fewer Minecraft versions than Standalone.',
          'Offline authentication is insecure and must not be used on a public network.',
          'Floodgate requires additional configuration on the Java server.',
        ],
      };
    },
    async planInstallation(request) {
      return {
        downloads: [
          {
            url: DOWNLOAD,
            destination: 'Geyser.jar',
            maximumBytes: 40000000,
            project: 'Geyser Standalone',
            version: request.geyserVersion || 'latest',
            license: 'MIT',
          },
        ],
        result: {
          provider: 'geyser',
          geyserVersion: request.geyserVersion || 'latest',
          javaMajor: 21,
          launchJar: 'Geyser.jar',
        },
      };
    },
    async planUpdate(record, request) {
      return this.planInstallation(request || record);
    },
    planLoaderMod(loader) {
      const kind = String(loader || '').toLowerCase();
      const url = kind === 'neoforge' ? NEOFORGE_DOWNLOAD : FABRIC_DOWNLOAD;
      return {
        downloads: [
          {
            url,
            destination: `mods/Geyser-${kind === 'neoforge' ? 'NeoForge' : 'Fabric'}.jar`,
            maximumBytes: 40000000,
            project: `Geyser ${kind}`,
            version: 'latest',
            license: 'MIT',
          },
        ],
        result: { loader: kind, javaMajor: 21 },
      };
    },
    getLaunchSpecification(record) {
      return {
        runtime: 'java',
        javaMajor: Number(record.java_major || 21),
        workingDirectory: '.',
        jar: 'Geyser.jar',
        arguments: ['--nogui'],
        memory: { minimum: '512M', maximum: '1G' },
        environment: {},
      };
    },
    getDefaultConfig(record) {
      const auth = record.authentication === 'floodgate' ? 'floodgate'
        : record.authentication === 'offline' ? 'offline' : 'online';
      return [
        'bedrock:',
        `  address: "${yamlEscape(record.bedrock_listen_address || '0.0.0.0')}"`,
        `  port: ${Number(record.bedrock_udp_port)}`,
        '  motd1: "Geyser"',
        `  motd2: "${yamlEscape(record.name)}"`,
        'remote:',
        `  address: "${yamlEscape(record.target_host || '127.0.0.1')}"`,
        `  port: ${Number(record.target_tcp_port || 25565)}`,
        `  auth-type: ${auth}`,
        'passthrough-motd: true',
        'passthrough-protocol-name: false',
        'passthrough-player-counts: true',
        `floodgate-key-file: "${yamlEscape(record.floodgate_key_file || 'key.pem')}"`,
        '',
      ].join('\n');
    },
    sanitizePublicRecord(record) {
      const { floodgate_key_path, floodgate_key_file, ...rest } = record || {};
      return {
        ...rest,
        floodgateConfigured: Boolean(floodgate_key_path),
        floodgate_key_path: undefined,
        floodgate_key_file: undefined,
      };
    },
  };
}

function registerRoutes(router, gateways) {
  if (!router || !gateways) return;

  router.get('/gateways', (req, res) => {
    try {
      res.json({ gateways: gateways.listOwn() });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/gateways', async (req, res) => {
    try {
      const gateway = await gateways.create(req.body || {});
      res.status(201).json(gateway);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/gateways/:id', (req, res) => {
    try {
      res.json(gateways.getOwn(req.params.id));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.patch('/gateways/:id', (req, res) => {
    try {
      res.json(gateways.updateOwn(req.params.id, req.body || {}));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.delete('/gateways/:id', (req, res) => {
    try {
      res.json(gateways.removeOwn(req.params.id));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/gateways/:id/start', async (req, res) => {
    try {
      res.json(await gateways.startOwn(req.params.id));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/gateways/:id/stop', (req, res) => {
    try {
      res.json(gateways.stopOwn(req.params.id));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/gateways/:id/restart', async (req, res) => {
    try {
      res.json(await gateways.restartOwn(req.params.id));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/gateways/:id/status', (req, res) => {
    try {
      res.json(gateways.statusOwn(req.params.id));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/gateways/:id/logs', (req, res) => {
    try {
      res.json(gateways.logsOwn(req.params.id));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/java-targets', (req, res) => {
    try {
      res.json({ servers: gateways.listJavaTargets() });
    } catch (err) {
      sendError(res, err);
    }
  });
}

module.exports = {
  createProvider,
  registerRoutes,
  register({ registerGateway, router, services }) {
    registerGateway(createProvider());
    registerRoutes(router, services && services.gateways);
  },
};
