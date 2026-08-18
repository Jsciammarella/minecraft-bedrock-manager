const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const modManager = require('../services/modManager');
const catalog = require('../services/catalogService');
const gitCatalog = require('../services/gitCatalogClient');
const packFiles = require('../services/packFiles');
const curseforgeImporter = require('../services/curseforgeImporter');
const mcpedlImporter = require('../services/mcpedlImporter');

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
    const allowed = packFiles.IMPORT_EXTS;
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error(packFiles.unsupportedMessage(ext)));
  }
});

const thumbsDir = path.join(__dirname, '../../data/mods/thumbs');
fs.mkdirSync(thumbsDir, { recursive: true });
const imageUpload = multer({
  storage: multer.diskStorage({
    destination: thumbsDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.png';
      cb(null, `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Use a PNG, JPEG, WebP, or GIF image.'));
  },
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

router.post('/import-curseforge', async (req, res) => {
  req.setTimeout(20 * 60 * 1000);
  res.setTimeout(20 * 60 * 1000);
  try {
    const result = await curseforgeImporter.importFromUrl(req.body?.url);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/import-mcpedl', async (req, res) => {
  req.setTimeout(20 * 60 * 1000);
  res.setTimeout(20 * 60 * 1000);
  try {
    const result = await mcpedlImporter.importFromUrl(req.body?.url);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', (req, res) => {
  imageUpload.single('thumbnail')(req, res, async (uploadError) => {
    if (uploadError) {
      const tooLarge = uploadError.code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 400).json({
        error: tooLarge ? 'The selected image exceeds the 5 MB limit.' : uploadError.message,
      });
    }

    try {
      const result = await modManager.updateMod(req.params.id, {
        description: req.body?.description,
        clearThumbnail: req.body?.clearThumbnail === '1' || req.body?.clearThumbnail === 'true',
      }, req.file || null);
      res.json(result);
    } catch (err) {
      if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      res.status(400).json({ error: err.message });
    }
  });
});

router.get('/:id/thumbnail', async (req, res) => {
  try {
    const filePath = modManager.getThumbnailFilePath(req.params.id);
    if (!filePath) return res.status(404).json({ error: 'Thumbnail not found' });
    res.sendFile(path.resolve(filePath), {
      headers: { 'Cache-Control': 'no-cache' },
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
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

// ========== MOD CATALOG ==========

router.get('/catalog/settings', async (req, res) => {
  try {
    res.json(catalog.getSettings());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/catalog/settings', async (req, res) => {
  try {
    const saved = catalog.saveSettings(req.body || {});
    const git = saved.git || {};
    if (git.enabled && git.url) {
      try {
        const sync = await gitCatalog.sync();
        saved.git = { ...saved.git, lastSync: sync.lastSync, modCount: sync.modCount };
      } catch (err) {
        saved.gitSyncError = err.message;
      }
    }
    res.json(saved);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/catalog/git/test', async (req, res) => {
  try {
    const result = await catalog.testGitConnection(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/catalog/git/sync', async (req, res) => {
  try {
    const result = await gitCatalog.sync();
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/catalog/git/thumbnail/:slug', async (req, res) => {
  try {
    const filePath = gitCatalog.getThumbnailPath(req.params.slug);
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Thumbnail not found' });
    }
    res.sendFile(path.resolve(filePath), {
      headers: { 'Cache-Control': 'no-cache' },
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/catalog/search', async (req, res) => {
  try {
    const result = await catalog.searchMods(req.query.q || '', {
      category: req.query.category,
      pageSize: parseInt(req.query.pageSize) || 40,
      page: parseInt(req.query.page) || 1,
      sortBy: req.query.sortBy || 'relevancy',
      source: req.query.source || 'all',
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/catalog/categories', async (req, res) => {
  try {
    const categories = await catalog.getCategories();
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/catalog/download/:slug', async (req, res) => {
  try {
    const result = await catalog.downloadMod(req.params.slug, req.body || {});
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/catalog/:slug', async (req, res) => {
  try {
    const details = await catalog.getDetails(req.params.slug, req.query);
    if (!details) return res.status(404).json({ error: 'Mod not found' });
    res.json(details);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
