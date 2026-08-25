module.exports = {
  title: 'CurseForge Catalog',
  description: 'Configure the shared CurseForge API key and independently enable Bedrock and Java catalog sources.',
  sections: [
    {
      id: 'api-key',
      title: 'CurseForge',
      description: 'A CurseForge API key makes search and downloads reliable. Both Bedrock and Java sources share this key. Get a key from the CurseForge developer console.',
      fields: [
        {
          id: 'consoleLink',
          type: 'link',
          label: 'Open the CurseForge developer console',
          href: 'https://console.curseforge.com/',
        },
        {
          id: 'apiKeyStatus',
          type: 'secret-status',
          label: 'API key status',
          help: 'A key is configured',
          placeholder: 'No key configured',
          storageKey: 'curseforge_api_key',
          secretId: 'apiKey',
        },
        {
          id: 'apiKey',
          type: 'secret',
          label: 'API Key',
          placeholder: 'Paste CurseForge API key',
          storageKey: 'curseforge_api_key',
          secretId: 'apiKey',
          clearLabel: 'Remove stored API key',
          replaceLabel: 'Replace key',
        },
        {
          id: 'testConnection',
          type: 'button',
          label: 'Test API connection',
          actionId: 'test-connection',
          variant: 'secondary',
          icon: 'check',
        },
      ],
    },
    {
      id: 'sources',
      title: 'Catalog sources',
      description: 'The plugin can stay enabled while both sources are turned off so you can still open this page.',
      fields: [
        {
          id: 'bedrockEnabled',
          type: 'toggle',
          label: 'Enable CurseForge Bedrock catalog',
          help: 'Show Minecraft Bedrock projects from CurseForge in the Mod Catalog',
        },
        {
          id: 'javaEnabled',
          type: 'toggle',
          label: 'Enable CurseForge Java catalog',
          help: 'Show Minecraft Java projects from CurseForge in the Mod Catalog',
        },
      ],
    },
  ],
  footerActions: [
    { id: 'save', label: 'Save Settings', variant: 'primary', icon: 'save' },
  ],
};
