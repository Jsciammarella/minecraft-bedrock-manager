const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function runPluginSettingsTests({ pluginHost, testRoot }) {
  const pluginSettings = require('../server/services/pluginSettings');
  const pluginSettingsSchema = require('../server/services/pluginSettingsSchema');
  const catalogProviderRegistry = require('../server/services/catalogProviderRegistry');
  const settingsStore = require('../server/services/settingsStore');
  const catalogPluginConfig = require('../server/services/catalogPluginConfig');
  const gitCatalogTemplate = require('../server/services/gitCatalogTemplate');
  const fileCatalogTemplate = require('../server/services/fileCatalogTemplate');

  pluginSettings.clear();
  pluginHost.resetForTests();

  const uploadedNative = pluginHost.parseManifest({
    id: 'evil-settings',
    name: 'Evil',
    pages: [{ id: 'settings', title: 'Nope', renderer: 'native-settings' }],
  }, 'evil-settings', { source: 'user' });
  assert.equal(uploadedNative.ok, false, 'uploaded plugins cannot request native-settings');

  assert.throws(
    () => pluginSettingsSchema.validateDescriptor({
      title: 'Bad',
      sections: [{ id: 's', title: 'S', fields: [{ id: 'x', type: 'text', label: '<script>alert(1)</script>' }] }],
    }, 'catalog-git'),
    /HTML|scripts/
  );
  assert.throws(
    () => pluginSettingsSchema.validateDescriptor({
      title: 'Bad',
      sections: [{ id: 's', title: 'S', fields: [{ id: 'x', type: 'link', href: 'javascript:alert(1)', label: 'x' }] }],
    }, 'catalog-git'),
    /https/
  );
  assert.throws(
    () => pluginSettingsSchema.validateDescriptor({
      title: 'Bad',
      sections: [{ id: 's', title: 'S', fields: [{ id: 'x', type: 'secret', storageKey: 'curseforge_api_key', label: 'k' }] }],
    }, 'catalog-git'),
    /does not own/
  );

  pluginHost.loadPlugins([pluginHost.BUNDLED_PLUGINS_DIR]);
  const cf = pluginHost.getPlugin('catalog-curseforge');
  assert.ok(cf && cf.enabled);
  assert.equal(cf.pages[0].renderer, 'native-settings');
  assert.equal(cf.pages[0].path, '/plugins/catalog-curseforge/settings');
  assert.ok(cf.menus.some((item) => item.path === '/plugins/catalog-curseforge/settings'));

  const page = pluginSettings.publicPage('catalog-curseforge');
  assert.equal(page.renderer, 'native-settings');
  assert.equal(JSON.stringify(page).includes('<script'), false);
  assert.equal(page.secrets.apiKey && typeof page.secrets.apiKey.configured, 'boolean');
  assert.equal(JSON.stringify(page).includes('cf-test-secret'), false);

  settingsStore.set(settingsStore.KEYS.CURSEFORGE_API_KEY, 'cf-test-secret-key-value');
  const withKey = pluginSettings.publicPage('catalog-curseforge');
  assert.equal(withKey.secrets.apiKey.configured, true);
  assert.equal(JSON.stringify(withKey).includes('cf-test-secret'), false);

  const other = { id: 'catalog-git', source: 'bundled', capabilities: ['provider:catalog-source'] };
  assert.throws(
    () => catalogProviderRegistry.unregister(other, 'curseforge-java'),
    /own catalog sources/
  );

  const saved = await pluginSettings.invokeAction('catalog-curseforge', 'save', {
    values: { bedrockEnabled: true, javaEnabled: false },
  });
  assert.equal(catalogProviderRegistry.get('curseforge-bedrock') != null, true);
  assert.equal(catalogProviderRegistry.get('curseforge-java'), null);
  assert.ok(saved.secrets.apiKey.configured);
  assert.equal(JSON.stringify(saved).includes('cf-test-secret'), false);

  await pluginSettings.invokeAction('catalog-curseforge', 'save', {
    values: { bedrockEnabled: false, javaEnabled: false },
  });
  assert.equal(catalogProviderRegistry.get('curseforge-bedrock'), null);
  assert.equal(catalogProviderRegistry.get('curseforge-java'), null);
  assert.ok(pluginHost.getPlugin('catalog-curseforge').enabled, 'plugin stays enabled with both sources off');

  await pluginSettings.invokeAction('catalog-curseforge', 'save', {
    values: { bedrockEnabled: false, javaEnabled: true },
  });
  assert.equal(catalogProviderRegistry.get('curseforge-bedrock'), null);
  assert.ok(catalogProviderRegistry.get('curseforge-java'));

  await pluginSettings.invokeAction('catalog-curseforge', 'save', {
    values: { bedrockEnabled: true, javaEnabled: true },
  });
  assert.ok(catalogProviderRegistry.get('curseforge-bedrock'));
  assert.ok(catalogProviderRegistry.get('curseforge-java'));

  pluginSettings.setPermissionResolver(() => false);
  await assert.rejects(
    () => pluginSettings.invokeAction('catalog-curseforge', 'save', { values: { bedrockEnabled: true } }),
    /permission/
  );
  pluginSettings.resetPermissionResolver();

  settingsStore.remove(settingsStore.KEYS.CURSEFORGE_API_KEY);
  const cleared = await pluginSettings.invokeAction('catalog-curseforge', 'save', {
    values: { bedrockEnabled: true, javaEnabled: true },
    secrets: { apiKey: { clear: true } },
  });
  assert.equal(cleared.secrets.apiKey.configured, false);

  settingsStore.remove(settingsStore.KEYS.CURSEFORGE_API_KEY);
  settingsStore.remove(settingsStore.KEYS.CF_BEDROCK_ENABLED);
  settingsStore.remove(settingsStore.KEYS.CF_JAVA_ENABLED);
  settingsStore.remove('catalog_curseforge_sources_migrated');
  fs.writeFileSync(process.env.MC_MANAGER_PLUGIN_STATE_PATH, JSON.stringify({
    enabled: { 'catalog-curseforge-java': false },
    backendEnabled: {},
  }));
  const migrated = catalogPluginConfig.migrateCurseForge();
  assert.equal(migrated.javaEnabled, false);
  assert.equal(migrated.bedrockEnabled, true);
  const again = catalogPluginConfig.migrateCurseForge();
  assert.equal(again.javaEnabled, false, 'migration is idempotent');

  const gitPage = pluginSettings.publicPage('catalog-git');
  assert.equal(gitPage.values.enabled, false);
  assert.equal(catalogProviderRegistry.get('git'), null);
  await pluginSettings.invokeAction('catalog-git', 'save', {
    values: { enabled: true, url: '', branch: 'main', username: '', subdir: '' },
  });
  assert.ok(catalogProviderRegistry.get('git'), 'enabling Git source registers the provider');
  await pluginSettings.invokeAction('catalog-git', 'save', {
    values: { enabled: false, url: '', branch: 'main', username: '', subdir: '' },
  });
  assert.equal(catalogProviderRegistry.get('git'), null);

  const filePage = pluginSettings.publicPage('catalog-file');
  assert.equal(filePage.values.enabled, true);
  assert.ok(catalogProviderRegistry.get('file'));
  await pluginSettings.invokeAction('catalog-file', 'save', {
    values: { enabled: false },
  });
  assert.equal(catalogProviderRegistry.get('file'), null);
  await pluginSettings.invokeAction('catalog-file', 'save', {
    values: { enabled: true, localEnabled: true },
  });
  assert.ok(catalogProviderRegistry.get('file'));

  const gitZip = gitCatalogTemplate.buildStarterZip();
  const fileZip = fileCatalogTemplate.buildStarterZip();
  assert.ok(Buffer.isBuffer(gitZip) && gitZip.length > 20);
  assert.ok(Buffer.isBuffer(fileZip) && fileZip.length > 20);

  settingsStore.set(settingsStore.KEYS.GIT_TOKEN, 'git-secret-token-value');
  settingsStore.set(settingsStore.KEYS.FILE_SMB_PASSWORD, 'smb-secret-password');
  const gitSecrets = pluginSettings.publicPage('catalog-git');
  const fileSecrets = pluginSettings.publicPage('catalog-file');
  assert.equal(gitSecrets.secrets.token.configured, true);
  assert.equal(fileSecrets.secrets.smbPassword.configured, true);
  assert.equal(JSON.stringify(gitSecrets).includes('git-secret'), false);
  assert.equal(JSON.stringify(fileSecrets).includes('smb-secret'), false);
  await pluginSettings.invokeAction('catalog-git', 'save', {
    values: { enabled: false, url: '', branch: 'main', username: '', subdir: '' },
  });
  await pluginSettings.invokeAction('catalog-file', 'save', {
    values: { enabled: true, localEnabled: true },
  });
  assert.equal(settingsStore.get(settingsStore.KEYS.GIT_TOKEN), 'git-secret-token-value');
  assert.equal(settingsStore.get(settingsStore.KEYS.FILE_SMB_PASSWORD), 'smb-secret-password');
  settingsStore.remove(settingsStore.KEYS.GIT_TOKEN);
  settingsStore.remove(settingsStore.KEYS.FILE_SMB_PASSWORD);

  settingsStore.remove(settingsStore.KEYS.CURSEFORGE_API_KEY);
  process.env.CURSEFORGE_API_KEY = 'env-cf-secret-value';
  const envPage = pluginSettings.publicPage('catalog-curseforge');
  assert.equal(envPage.secrets.apiKey.configured, true, 'environment API key should count as configured');
  assert.equal(JSON.stringify(envPage).includes('env-cf-secret'), false);
  delete process.env.CURSEFORGE_API_KEY;

  const gitDownload = await pluginSettings.invokeAction('catalog-git', 'download-template', {});
  assert.equal(gitDownload.download, true);
  assert.ok(Buffer.isBuffer(gitDownload.buffer) && gitDownload.buffer.length > 20);
  const fileDownload = await pluginSettings.invokeAction('catalog-file', 'download-template', {});
  assert.equal(fileDownload.download, true);
  assert.ok(Buffer.isBuffer(fileDownload.buffer) && fileDownload.buffer.length > 20);

  await assert.rejects(
    () => pluginSettings.invokeAction('catalog-git', 'test-local-path', {}),
    /Unknown settings action/
  );
  await assert.rejects(
    () => pluginSettings.invokeAction('catalog-curseforge', 'save', { command: 'rm -rf /', values: {} }),
    /URLs or commands/
  );

  assert.throws(
    () => pluginSettings.assertSameOrigin({
      get: (name) => (name === 'origin' ? 'https://evil.example' : name === 'host' ? 'localhost:3000' : ''),
    }),
    /Cross-origin/
  );
  pluginSettings.assertSameOrigin({ get: () => '' });
  pluginSettings.assertSameOrigin({
    get: (name) => (name === 'origin' ? 'http://localhost:3000' : name === 'host' ? 'localhost:3000' : ''),
  });

  assert.throws(
    () => pluginSettingsSchema.validateDescriptor({
      title: 'Bad',
      css: 'body { color: red }',
      sections: [{ id: 's', title: 'S', fields: [{ id: 'x', type: 'text', label: 'ok' }] }],
    }, 'catalog-git'),
    /HTML|JSX|CSS|JavaScript/
  );
  assert.throws(
    () => pluginSettingsSchema.validateDescriptor({
      title: 'Bad',
      sections: [{ id: 's', title: 'S', fields: [{ id: 'x', type: 'text', label: 'ok', command: 'rm' }] }],
    }, 'catalog-git'),
    /executable|command/
  );

  const pluginPageSrc = fs.readFileSync(path.join(__dirname, '../frontend/src/pages/PluginPage.jsx'), 'utf8');
  assert.match(pluginPageSrc, /native-settings/);
  assert.match(pluginPageSrc, /NativePluginSettings/);
  const catalogSrc = fs.readFileSync(path.join(__dirname, '../frontend/src/pages/ModCatalog.jsx'), 'utf8');
  assert.doesNotMatch(catalogSrc, /Catalog Settings/);
  assert.doesNotMatch(catalogSrc, /\/mods\/catalog\/settings/);
  const appSrc = fs.readFileSync(path.join(__dirname, '../frontend/src/App.jsx'), 'utf8');
  assert.match(appSrc, /mods\/catalog\/settings/);
  assert.match(appSrc, /Navigate to="\/plugins"/);
  assert.equal(
    fs.existsSync(path.join(__dirname, '../frontend/src/pages/ModCatalogSettings.jsx')),
    false,
    'old catalog settings page should be removed'
  );
  const nativeSrc = fs.readFileSync(
    path.join(__dirname, '../frontend/src/components/pluginSettings/NativePluginSettings.jsx'),
    'utf8'
  );
  assert.doesNotMatch(nativeSrc, /<iframe/);
  assert.match(nativeSrc, /SettingsPageHeader/);
  assert.match(nativeSrc, /ToggleRow/);
  assert.match(nativeSrc, /SecretField/);
  assert.match(nativeSrc, /max-w-3xl/);
  assert.match(nativeSrc, /p-4 md:p-6/);
  assert.match(nativeSrc, /grid-cols-1 md:grid-cols-2/);
  assert.match(catalogSrc, /multi-file|multiFileMode/);
  assert.doesNotMatch(catalogSrc, /Settings className="w-5 h-5"/);

  settingsStore.set(settingsStore.KEYS.CF_BEDROCK_ENABLED, '1');
  settingsStore.set(settingsStore.KEYS.CF_JAVA_ENABLED, '1');
  settingsStore.set(settingsStore.KEYS.FILE_ENABLED, '1');
  settingsStore.set(settingsStore.KEYS.GIT_ENABLED, '0');
  pluginHost.resetForTests();
  pluginSettings.clear();
}

module.exports = { runPluginSettingsTests };
