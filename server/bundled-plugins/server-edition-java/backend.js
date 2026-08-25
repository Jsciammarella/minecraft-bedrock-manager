function createProvider() {
  return {
    getMetadata() {
      return {
        id: 'java',
        label: 'Java',
        name: 'Java',
      };
    },
  };
}

module.exports = {
  createProvider,
  register({ registerServerEdition }) {
    if (typeof registerServerEdition !== 'function') {
      throw new Error('Minecraft Java Hosting requires the server-edition registry');
    }
    registerServerEdition(createProvider());
  },
};
