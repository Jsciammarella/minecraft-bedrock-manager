const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const modManager = require('../services/modManager');
const curseforge = require('../services/curseforgeClient');

// Multer config for file uploads
const uploadsDir = path.join(__dirname, '../../data/uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => {
      const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${safeName}`);
    },
  }),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB; files stream to disk instead of memory
  fileFilter: (req, file, cb) => {
    const allowed = ['.mcpack', '.mcaddon', '.mcworld', '.zip', '.mctemplate'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error(`Unsupported file type ${ext || '(none)'}. Use .mcpack, .mcaddon, .mcworld, .zip, or .mctemplate.`));
  }
});

// Get all mods in library
router.get('/', async (req, res) => {
  try {
    const mods = await modManager.getAllMods();
    res.json(mods);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get mod by ID
router.get('/:id', async (req, res) => {
  try {
    const mod = await modManager.getModById(req.params.id);
    if (!mod) return res.status(404).json({ error: 'Mod not found' });
    res.json(mod);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload a mod. Handle Multer here so validation errors are always useful JSON.
router.post('/upload', (req, res) => {
  upload.single('file')(req, res, async (uploadError) => {
    if (uploadError) {
      const tooLarge = uploadError.code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 400).json({
        error: tooLarge ? 'The selected file exceeds the 1 GB upload limit.' : uploadError.message,
      });
    }

    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const result = await modManager.uploadMod(req.file, req.body);
      res.status(201).json(result);
    } catch (err) {
      if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      res.status(400).json({ error: err.message });
    }
  });
});

// Delete a mod from library
router.delete('/:id', async (req, res) => {
  try {
    await modManager.deleteMod(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get available mods for a server (not yet installed)
router.get('/available/:serverId', async (req, res) => {
  try {
    const mods = await modManager.getAvailableMods(req.params.serverId);
    res.json(mods);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get installed mods for a server
router.get('/installed/:serverId', async (req, res) => {
  try {
    const mods = await modManager.getInstalledMods(req.params.serverId);
    res.json(mods);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Install mod to server
router.post('/:modId/install/:serverId', async (req, res) => {
  try {
    await modManager.installModToServer(req.params.serverId, req.params.modId);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Uninstall mod from server
router.delete('/:modId/uninstall/:serverId', async (req, res) => {
  try {
    await modManager.uninstallModFromServer(req.params.serverId, req.params.modId);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ========== CURSEFORGE CATALOG ==========

// Search CurseForge
router.get('/catalog/search', async (req, res) => {
  try {
    const result = await curseforge.searchMods(req.query.q || '', {
      category: req.query.category,
      pageSize: parseInt(req.query.pageSize) || 20,
      page: parseInt(req.query.page) || 1,
      sortBy: req.query.sortBy || 'relevancy',
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get CurseForge categories
router.get('/catalog/categories', async (req, res) => {
  try {
    const categories = await curseforge.getCategories();
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download mod from CurseForge
router.post('/catalog/download/:slug', async (req, res) => {
  try {
    const result = await curseforge.downloadMod(
      req.params.slug,
      req.body.projectClass,
      req.body.serverId,
      { modId: req.body.curseforgeId, fileId: req.body.fileId }
    );
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get mod details from CurseForge
router.get('/catalog/:slug', async (req, res) => {
  try {
    const details = await curseforge.getModDetails(req.params.slug, req.query.projectClass);
    if (!details) return res.status(404).json({ error: 'Mod not found' });
    res.json(details);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
