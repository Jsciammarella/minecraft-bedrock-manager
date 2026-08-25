const schema = require('./settings');
const { createProvider: createBedrock } = require('./providers/bedrock');
const { createProvider: createJava } = require('./providers/java');

function syncSources(ctx, sources) {
  const bedrock = createBedrock(ctx.services);
  const java = createJava(ctx.services);
  if (sources.bedrockEnabled) ctx.registerCatalogSource(bedrock);
  else ctx.unregisterCatalogSource('curseforge-bedrock');
  if (sources.javaEnabled) ctx.registerCatalogSource(java);
  else ctx.unregisterCatalogSource('curseforge-java');
}

function register(ctx) {
  const { services, registerPluginSettings } = ctx;
  const sources = services.catalogConfig.migrateCurseForge();
  syncSources(ctx, sources);

  registerPluginSettings({
    schema,
    getState() {
      const next = services.catalogConfig.getCurseForgeSources();
      return {
        values: {
          bedrockEnabled: next.bedrockEnabled,
          javaEnabled: next.javaEnabled,
        },
        status: {},
      };
    },
    actions: {
      async save({ values, actor }) {
        const next = services.catalogConfig.setCurseForgeSources({
          bedrockEnabled: values.bedrockEnabled,
          javaEnabled: values.javaEnabled,
        }, { actor });
        syncSources(ctx, next);
        return { message: 'Catalog settings saved' };
      },
      async 'test-connection'() {
        if (!services.catalogHttp.isConfigured('curseforge')) {
          throw Object.assign(
            new Error('CurseForge catalog access requires an API key. Open the CurseForge Catalog plugin settings to add it.'),
            { status: 400, code: 'CURSEFORGE_API_KEY_REQUIRED' }
          );
        }
        await services.catalogHttp.request({
          credentialProfile: 'curseforge',
          url: 'https://api.curseforge.com/v1/games/78022',
        });
        return { ok: true, message: 'CurseForge API key is valid' };
      },
    },
  });
}

module.exports = { register };
