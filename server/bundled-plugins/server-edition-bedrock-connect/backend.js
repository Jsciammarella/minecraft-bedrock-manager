function createProvider() {
  return {
    getMetadata() {
      return {
        id: 'bedrock-connect',
        label: 'BedrockConnect',
        name: 'BedrockConnect',
        kind: 'bedrock_connect',
        createSurface: 'dashboard',
        createPermission: 'bedrock_connect.create',
        catalogFilter: false,
      };
    },
  };
}

async function onEnable() {
  const policy = require('../../services/bedrockConnectPolicy');
  if (typeof policy.onPluginEnabled === 'function') {
    await policy.onPluginEnabled();
  }
}

async function onDisable() {
  const policy = require('../../services/bedrockConnectPolicy');
  if (typeof policy.onPluginDisabled === 'function') {
    await policy.onPluginDisabled();
  }
}

module.exports = {
  createProvider,
  onEnable,
  onDisable,
  register({ registerServerEdition }) {
    if (typeof registerServerEdition !== 'function') {
      throw new Error('BedrockConnect requires the server-edition registry');
    }
    registerServerEdition(createProvider());
  },
};
