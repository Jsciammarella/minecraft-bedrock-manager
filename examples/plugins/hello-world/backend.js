module.exports = {
  register({ router, id }) {
    router.get('/hello', (req, res) => {
      res.json({
        plugin: id,
        message: 'Hello from the example plugin backend.',
      });
    });
  },
};
