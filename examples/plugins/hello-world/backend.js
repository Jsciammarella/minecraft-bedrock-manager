module.exports = {
  register({ router, id, can }) {
    router.get('/hello', (req, res) => {
      if (!can(req, 'greet')) {
        return res.status(403).json({ error: 'You do not have permission to do that' });
      }
      res.json({
        plugin: id,
        message: 'Hello from the example plugin backend.',
      });
    });
  },
};
