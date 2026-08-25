const DOWNLOAD = 'https://download.geysermc.org/v2/projects/geyser/versions/latest/builds/latest/downloads/standalone';
const FABRIC_DOWNLOAD = 'https://download.geysermc.org/v2/projects/geyser/versions/latest/builds/latest/downloads/fabric';
const NEOFORGE_DOWNLOAD = 'https://download.geysermc.org/v2/projects/geyser/versions/latest/builds/latest/downloads/neoforge';
const GEYSER_VIAPROXY_DOWNLOAD = 'https://download.geysermc.org/v2/projects/geyser/versions/latest/builds/latest/downloads/viaproxy';
const VIAPROXY_VERSION = '3.4.12';
const VIAPROXY_DOWNLOAD = `https://github.com/ViaVersion/ViaProxy/releases/download/v${VIAPROXY_VERSION}/ViaProxy-${VIAPROXY_VERSION}.jar`;
const GEYSER_NATIVE_JAVA_VERSIONS = ['1.26.2'];
const FLOODGATE_SPIGOT_DOWNLOAD = 'https://download.geysermc.org/v2/projects/floodgate/versions/latest/builds/latest/downloads/spigot';
const FLOODGATE_NEOFORGE_DOWNLOAD = 'https://cdn.modrinth.com/data/bWrNNfkb/versions/YapRHgnZ/Floodgate-Neoforge-2.2.4-b38.jar';
const FLOODGATE_FABRIC_DOWNLOAD = 'https://cdn.modrinth.com/data/bWrNNfkb/versions/Mf2wV7re/Floodgate-Fabric-2.2.4-b38.jar';
const DOWNLOAD_HOSTS = [
  'download.geysermc.org',
  'repo.opencollab.dev',
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'cdn.modrinth.com',
];

function yamlEscape(value) {
  return String(value ?? '').replace(/"/g, '\\"');
}

function socketAddress(host, port) {
  const hostname = String(host || '127.0.0.1').trim() || '127.0.0.1';
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw Object.assign(new Error('Invalid port for ViaProxy address'), { status: 400 });
  }
  const wrapped = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
  return `${wrapped}:${n}`;
}

function zipStore(files) {
  const zlib = require('zlib');
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'));
    const crc = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const localFile = Buffer.concat([local, nameBuf, data]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(localFile);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += localFile.length;
  }
  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length, 8);
  end.writeUInt16LE(centrals.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, end]);
}

function findJavac() {
  const fs = require('fs');
  const path = require('path');
  const javaRuntime = require('../../services/javaRuntime');
  const exe = process.platform === 'win32' ? 'javac.exe' : 'javac';
  const homes = [];
  if (process.env.JAVA_HOME) homes.push(process.env.JAVA_HOME);
  const runtimes = javaRuntime.RUNTIMES_DIR;
  if (fs.existsSync(runtimes)) {
    for (const name of fs.readdirSync(runtimes)) {
      const nested = path.join(runtimes, name);
      homes.push(nested);
      try {
        for (const inner of fs.readdirSync(nested)) homes.push(path.join(nested, inner));
      } catch { /* ignore */ }
    }
  }
  for (const home of homes) {
    const candidate = path.join(home, 'bin', exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function ensureFloodgateJoinPlugin(record) {
  if (record.authentication !== 'floodgate') return;
  if (String(record.compatibility_mode || 'direct') !== 'viaproxy') return;
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { execFileSync } = require('child_process');
  const viaJar = path.join(record.data_path, 'ViaProxy.jar');
  if (!fs.existsSync(viaJar) || fs.statSync(viaJar).size < 1000000) return;
  const dest = path.join(record.data_path, 'plugins', 'FloodgateJoin.jar');
  const srcJava = path.join(__dirname, 'viaproxy-floodgate', 'FloodgateJoinPlugin.java');
  const srcYml = path.join(__dirname, 'viaproxy-floodgate', 'viaproxy.yml');
  if (fs.existsSync(dest) && fs.existsSync(srcJava) && fs.statSync(dest).mtimeMs >= fs.statSync(srcJava).mtimeMs) {
    return;
  }
  const javac = findJavac();
  if (!javac) {
    throw Object.assign(
      new Error('Floodgate with ViaProxy needs javac to build the join helper. The managed Java runtime should include it; start the gateway again after Java is installed.'),
      { status: 500, code: 'FLOODGATE_JOIN_PLUGIN' }
    );
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-join-'));
  try {
    execFileSync(javac, ['-cp', viaJar, '-d', tmp, srcJava], { stdio: 'pipe', timeout: 60000 });
    const classRel = 'org/mcmanager/viaproxy/FloodgateJoinPlugin.class';
    const classPath = path.join(tmp, classRel);
    if (!fs.existsSync(classPath)) {
      throw Object.assign(new Error('FloodgateJoin plugin did not compile'), { status: 500 });
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, zipStore({
      'viaproxy.yml': fs.readFileSync(srcYml),
      [classRel]: fs.readFileSync(classPath),
    }));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function sendError(res, err) {
  res.status(err.status || 400).json({
    error: err.message,
    code: err.code,
    preview: err.preview,
  });
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
        downloadHosts: DOWNLOAD_HOSTS,
        viaproxyVersion: VIAPROXY_VERSION,
        notices: [
          'Powered by Geyser. Not affiliated with or endorsed by GeyserMC, Mojang, or Microsoft.',
          'Standalone is recommended when the Java server matches Geyser\'s native protocol.',
          'ViaProxy compatibility is optional and is never installed unless you choose it.',
          'Offline authentication is insecure and must not be used on a public network.',
          'Floodgate requires the same raw 16-byte key.pem on Geyser and the Java Floodgate plugin.',
          'For a local Java server, Start installs Floodgate into mods/ or plugins/ if it is missing, copies the key, and restarts that Java server.',
          'ViaProxy CLI still refuses online-mode Java without a join helper. Start compiles FloodgateJoin.jar against ViaProxy so Floodgate can authenticate Bedrock players.',
          'Geyser Standalone and ViaProxy join as a vanilla Java client. NeoForge/Fabric packs that require client mods (Create, and most content mods) will kick Bedrock players. Xbox cannot install NeoForge.',
          'ViaProxy is GPL-3.0; Geyser is MIT. Binaries are downloaded at runtime and are not bundled.',
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
      if (String(record.compatibility_mode || 'direct') === 'viaproxy') {
        return {
          runtime: 'java',
          javaMajor: Number(record.java_major || 21),
          workingDirectory: '.',
          jar: 'ViaProxy.jar',
          arguments: ['config', 'viaproxy.yml'],
          memory: { minimum: '512M', maximum: '1G' },
          environment: {},
        };
      }
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
    checkCompatibility(record, extra = {}) {
      const version = String(extra.minecraftVersion || record.target_minecraft_version || '').trim();
      const loader = String(extra.loaderProviderId || record.target_loader_provider_id || '').toLowerCase();
      const viaEnabled = String(record.compatibility_mode || 'direct') === 'viaproxy';
      const modded = ['neoforge', 'forge', 'fabric'].includes(loader);
      if (!version) {
        return {
          compatible: !modded,
          recommendedMode: 'direct',
          targetVersion: null,
          nativeVersions: GEYSER_NATIVE_JAVA_VERSIONS,
          message: modded
            ? 'This Java server uses a mod loader. Geyser Standalone and ViaProxy join as a vanilla Java client, so NeoForge/Fabric will kick Bedrock players if a vanilla Java client could not join. Xbox cannot install NeoForge.'
            : 'Could not determine the Java protocol. Direct Geyser works only if the server matches Geyser\'s native version.',
        };
      }
      const protocolOk = GEYSER_NATIVE_JAVA_VERSIONS.some((native) => version === native || version.startsWith(`${native}.`) || native.startsWith(version));
      if (modded) {
        return {
          compatible: false,
          recommendedMode: viaEnabled || !protocolOk ? 'viaproxy' : 'direct',
          viaProxyEnabled: viaEnabled,
          targetVersion: version,
          nativeVersions: GEYSER_NATIVE_JAVA_VERSIONS,
          loader,
          code: 'MODDED_CLIENT_REQUIRED',
          message: protocolOk
            ? 'Geyser Standalone and ViaProxy join as a vanilla Java client. A NeoForge or Fabric server that requires client mods (for example Create) will kick Bedrock players asking them to install NeoForge. Xbox cannot install NeoForge. Geyser-NeoForge on the Java server only helps when a vanilla Java client could join, or the pack is server-side-only.'
            : 'ViaProxy can translate Geyser\'s Java protocol to this server version, but it still joins as vanilla Java. NeoForge then kicks Bedrock players. Client-required mods such as Create are not supported by Geyser. Current Xbox Bedrock plus a 1.21.1 Create pack cannot be bridged with ViaProxy.',
        };
      }
      if (protocolOk) {
        return {
          compatible: true,
          recommendedMode: 'direct',
          targetVersion: version,
          nativeVersions: GEYSER_NATIVE_JAVA_VERSIONS,
          message: 'Direct Geyser can target this Java version.',
        };
      }
      return {
        compatible: false,
        recommendedMode: 'viaproxy',
        viaProxyEnabled: viaEnabled,
        targetVersion: version,
        nativeVersions: GEYSER_NATIVE_JAVA_VERSIONS,
        message: viaEnabled
          ? 'This Java version needs ViaProxy. Compatibility mode is already enabled, so Bedrock players join through ViaProxy rather than native Geyser.'
          : 'This Java server does not support the protocol required by the current Geyser release. Enable ViaProxy compatibility mode or update the Java server.',
        action: viaEnabled ? undefined : 'Use ViaProxy Compatibility Mode',
      };
    },
    planFloodgateInstallation(server) {
      const loader = String(server?.loader_provider_id || server?.loader || '').toLowerCase();
      const download = (url, destination, project, version) => ({
        downloads: [{
          url,
          destination,
          maximumBytes: 8000000,
          project,
          version,
          license: 'MIT',
        }],
        result: { loader, floodgateVersion: version, destinationKind: destination.split('/')[0] },
      });
      if (loader === 'neoforge') {
        return download(FLOODGATE_NEOFORGE_DOWNLOAD, 'mods/Floodgate.jar', 'Floodgate NeoForge', '2.2.4-b38');
      }
      if (loader === 'fabric') {
        return download(FLOODGATE_FABRIC_DOWNLOAD, 'mods/Floodgate.jar', 'Floodgate Fabric', '2.2.4-b38');
      }
      if (['paper', 'spigot', 'purpur', 'bukkit'].includes(loader)) {
        return download(FLOODGATE_SPIGOT_DOWNLOAD, 'plugins/floodgate-spigot.jar', 'Floodgate Spigot', 'latest');
      }
      throw Object.assign(
        new Error(`Floodgate is not available for the ${loader || 'unknown'} Java loader. Use Fabric, NeoForge, or Paper, then copy the same key.pem.`),
        { status: 400, code: 'FLOODGATE_UNSUPPORTED_LOADER' }
      );
    },
    async planCompatibilityInstallation(request) {
      if (!request?.confirmViaProxy) {
        throw Object.assign(new Error('ViaProxy is not installed unless you confirm that choice'), { status: 400 });
      }
      return {
        downloads: [
          {
            url: VIAPROXY_DOWNLOAD,
            destination: 'ViaProxy.jar',
            maximumBytes: 80000000,
            project: 'ViaProxy',
            version: VIAPROXY_VERSION,
            license: 'GPL-3.0',
          },
          {
            url: GEYSER_VIAPROXY_DOWNLOAD,
            destination: 'plugins/Geyser-ViaProxy.jar',
            maximumBytes: 40000000,
            project: 'Geyser-ViaProxy',
            version: request.geyserVersion || 'latest',
            license: 'MIT',
          },
        ],
        result: {
          provider: 'geyser',
          compatibilityMode: 'viaproxy',
          viaproxyVersion: VIAPROXY_VERSION,
          geyserViaProxyVersion: request.geyserVersion || 'latest',
          javaMajor: 21,
        },
      };
    },
    validateLaunch(record) {
      if (String(record.compatibility_mode || 'direct') === 'viaproxy' && record.authentication === 'online') {
        throw Object.assign(new Error('ViaProxy CLI mode cannot join an online-mode Java server without Floodgate. Enable Floodgate on the Java server or use offline authentication (insecure).'), { status: 400, code: 'AUTH_INCOMPATIBLE' });
      }
    },
    getRuntimeFiles(record) {
      if (String(record.compatibility_mode || 'direct') !== 'viaproxy') return [];
      const bindPort = Number(record.viaproxy_bind_port || 25568);
      const auth = record.authentication === 'floodgate' ? 'floodgate'
        : record.authentication === 'offline' ? 'offline' : 'online';
      const geyserConfig = [
        'bedrock:',
        `  address: "${yamlEscape(record.bedrock_listen_address || '0.0.0.0')}"`,
        `  port: ${Number(record.bedrock_udp_port)}`,
        '  motd1: "Geyser"',
        `  motd2: "${yamlEscape(record.name)}"`,
        'remote:',
        `  address: "${yamlEscape(record.target_host || '127.0.0.1')}"`,
        `  port: ${Number(record.target_tcp_port || 25565)}`,
        `  auth-type: ${auth}`,
        'use-direct-connection: true',
        'passthrough-motd: false',
        'passthrough-protocol-name: false',
        'passthrough-player-counts: false',
        `floodgate-key-file: "${yamlEscape(record.floodgate_key_file || 'key.pem')}"`,
        '',
      ].join('\n');
      const viaConfig = [
        `bind-address: ${socketAddress('127.0.0.1', bindPort)}`,
        `target-address: ${socketAddress(record.target_host || '127.0.0.1', record.target_tcp_port || 25565)}`,
        'proxy-online-mode: false',
        'auth-method: NONE',
        'wildcard-domain-handling: NONE',
        '',
      ].join('\n');
      return [
        { destination: 'viaproxy.yml', contents: viaConfig },
        { destination: 'plugins/Geyser/config.yml', contents: geyserConfig },
      ];
    },
    prepareRuntime(record) {
      if (String(record.compatibility_mode || 'direct') !== 'viaproxy') return;
      const fs = require('fs');
      const path = require('path');
      const src = path.join(record.data_path, 'key.pem');
      const dest = path.join(record.data_path, 'plugins', 'Geyser', 'key.pem');
      if (record.authentication === 'floodgate' && fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
        try { fs.chmodSync(dest, 0o600); } catch { /* ignore */ }
      }
      ensureFloodgateJoinPlugin(record);
    },
    getDashboardEntity(record) {
      return {
        gatewayId: record.id,
        kind: 'geyser_gateway',
        name: record.name,
        compatibilityMode: record.compatibility_mode === 'viaproxy' ? 'viaproxy' : 'direct',
        geyserVersion: record.geyser_version,
        viaproxyVersion: record.viaproxy_version,
        authentication: record.authentication,
      };
    },
    getServerContribution({ attachment, javaServer, pluginDisabled } = {}) {
      const db = require('../../db/connection');
      const id = Number(attachment?.resource_id);
      const record = db.prepare('SELECT * FROM gateways WHERE id = ?').get(id);
      if (!record) return null;
      const via = record.compatibility_mode === 'viaproxy';
      const floodgate = record.authentication === 'floodgate';
      const health = pluginDisabled
        ? 'plugin_disabled'
        : (record.health_status || record.status || 'stopped');
      const running = health === 'running' || health === 'starting' || health === 'degraded';
      const javaOffline = Boolean(javaServer) && javaServer.status !== 'running';
      let indicator = { id: 'geyser-status', label: 'Geyser Offline', state: 'offline' };
      if (pluginDisabled) indicator = { id: 'geyser-status', label: 'Geyser Plugin Disabled', state: 'plugin_disabled' };
      else if (health === 'starting') indicator = { id: 'geyser-status', label: 'Geyser Starting', state: 'starting' };
      else if (health === 'degraded') indicator = { id: 'geyser-status', label: 'Geyser Degraded', state: 'degraded' };
      else if (health === 'running') indicator = { id: 'geyser-status', label: 'Geyser Online', state: 'online' };
      else if (['failed', 'auth_misconfigured', 'protocol_incompatible', 'target_unreachable', 'port_conflict'].includes(health)) {
        indicator = { id: 'geyser-status', label: 'Geyser Failed', state: 'failed' };
      }
      const startDisabled = !running && javaOffline;
      const tags = [
        via
          ? { id: 'geyser-mode', label: 'Geyser · ViaProxy', style: 'info' }
          : { id: 'geyser-mode', label: 'Geyser', style: 'info' },
      ];
      if (floodgate) tags.push({ id: 'floodgate', label: 'Floodgate', style: 'success' });
      const connectHost = require('../../services/connectHost');
      return {
        pluginId: 'gateway-geyser',
        serverId: attachment?.server_id || javaServer?.id || null,
        attachmentId: `gateway:${record.id}`,
        revision: Date.parse(record.updated_at || '') || Date.now(),
        tags,
        indicators: [indicator],
        actions: pluginDisabled ? [] : [{
          id: 'toggle-gateway',
          label: running && health !== 'starting' ? 'Stop Geyser' : health === 'starting' ? 'Starting Geyser' : 'Start Geyser',
          placement: 'primary-split',
          variant: running ? 'danger' : 'primary',
          state: startDisabled || health === 'starting' ? 'disabled' : 'enabled',
          icon: running ? 'stop' : 'play',
          confirmation: false,
          disabledReason: startDisabled ? 'Start the Java server before starting Geyser.' : '',
        }],
        summary: {
          mode: via ? 'ViaProxy' : 'Direct Geyser',
          status: indicator.label,
          bedrockAddress: connectHost.resolve(),
          bedrockPort: String(record.bedrock_udp_port || ''),
          viaProxyStatus: via ? (record.viaproxy_version ? `Installed (${record.viaproxy_version})` : 'Enabled') : 'Not used',
          floodgateStatus: floodgate ? 'Enabled' : 'Not enabled',
          lastError: record.last_error || '',
        },
        management: {
          label: 'Manage Geyser Plugin',
          pluginPage: 'gateway-geyser',
          resourceId: String(record.id),
        },
        controlPolicy: javaServer ? 'normal' : 'remote-plugin-lifecycle',
      };
    },
    getAdvertisedEndpoint(record) {
      return {
        name: `${record.name} — Geyser`,
        port: Number(record.bedrock_udp_port),
        internal: false,
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

  router.patch('/gateways/:id', async (req, res) => {
    try {
      res.json(await gateways.updateOwn(req.params.id, req.body || {}));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/gateways/:id/apply-settings', async (req, res) => {
    try {
      res.json(await gateways.applySettingsOwn(req.params.id, req.body || {}));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/gateways/:id/floodgate/key', (req, res) => {
    try {
      const file = gateways.exportFloodgateKeyOwn(req.params.id);
      res.json({
        filename: file.filename,
        contentBase64: Buffer.from(file.bytes).toString('base64'),
      });
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

  router.get('/gateways/:id/compatibility', (req, res) => {
    try {
      res.json(gateways.checkCompatibilityOwn(req.params.id));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/gateways/:id/floodgate/install', async (req, res) => {
    try {
      res.json(await gateways.installFloodgateOwn(req.params.id, req.body || {}));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/gateways/:id/viaproxy/install', async (req, res) => {
    try {
      res.json(await gateways.installCompatibilityOwn(req.params.id, req.body || {}));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/gateways/:id/viaproxy/remove', async (req, res) => {
    try {
      res.json(await gateways.removeCompatibilityOwn(req.params.id, req.body || {}));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/gateways/:id/viaproxy/upgrade', async (req, res) => {
    try {
      res.json(await gateways.installCompatibilityOwn(req.params.id, { ...(req.body || {}), confirmViaProxy: true }));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/gateways/:id/dashboard-primary', (req, res) => {
    try {
      const row = gateways.getOwn(req.params.id);
      const attachments = require('../../services/serverPluginAttachments');
      const att = attachments.findByResource('gateway-geyser', 'gateway', String(row.id));
      if (!att) {
        return res.status(400).json({ error: 'Only a gateway attached to a local Java server can be shown on that server tile' });
      }
      res.json(attachments.setPrimary(att.id));
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/gateways/:id/viaproxy/repair', async (req, res) => {
    try {
      res.json(await gateways.installCompatibilityOwn(req.params.id, { ...(req.body || {}), confirmViaProxy: true }));
    } catch (err) {
      sendError(res, err);
    }
  });
}

module.exports = {
  GEYSER_NATIVE_JAVA_VERSIONS,
  VIAPROXY_DOWNLOAD,
  VIAPROXY_VERSION,
  FLOODGATE_NEOFORGE_DOWNLOAD,
  FLOODGATE_FABRIC_DOWNLOAD,
  FLOODGATE_SPIGOT_DOWNLOAD,
  DOWNLOAD_HOSTS,
  createProvider,
  registerRoutes,
  register({ registerGateway, registerPluginAction, router, services }) {
    registerGateway(createProvider());
    registerRoutes(router, services && services.gateways);
    if (typeof registerPluginAction === 'function' && services?.gateways) {
      registerPluginAction({
        id: 'toggle-gateway',
        resourceType: 'gateway',
        permission: 'gateway:lifecycle',
        confirmation: false,
        async handler({ resourceId }) {
          const status = services.gateways.statusOwn(resourceId);
          const running = Boolean(status.running) || status.status === 'running' || status.status === 'starting';
          if (running) return services.gateways.stopOwn(resourceId);
          return services.gateways.startOwn(resourceId);
        },
      });
    }
  },
};
