const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const modManager = require('../services/modManager');
const catalog = require('../services/catalogService');
const gitCatalog = require('../services/gitCatalogClient');
const fileCatalog = require('../services/fileCatalogClient');
const packFiles = require('../services/packFiles');
const curseforgeImporter = require('../services/curseforgeImporter');
const mcpedlImporter = require('../services/mcpedlImporter');
const { requirePermission, assertPermission, resolveServerResource, requireServerVisible, requireServerPermission } = require('../middleware/auth');

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
  limits: { fileSize: 1024 * 1024 * 1024, files: 20 }, // 1GB each; files stream to disk instead of memory
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
router.get('/', requirePermission('library.view'), async (req, res) => {
  try {
    const mods = await modManager.getAllMods();
    res.json(mods);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get mod by ID
router.get('/:id', requirePermission('library.view'), async (req, res) => {
  try {
    const mod = await modManager.getModById(req.params.id);
    if (!mod) return res.status(404).json({ error: 'Mod not found' });
    res.json(mod);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function collectedUploads(req) {
  if (Array.isArray(req.files)) return req.files;
  if (req.files && typeof req.files === 'object') {
    return [...(req.files.files || []), ...(req.files.file || [])];
  }
  return req.file ? [req.file] : [];
}

function unlinkUploads(files) {
  for (const file of files || []) {
    if (file?.path && fs.existsSync(file.path)) {
      try { fs.unlinkSync(file.path); } catch { /* ignore */ }
    }
  }
}

// Upload a mod. Handle Multer here so validation errors are always useful JSON.
// Accepts a single "file" field (older clients) or multiple "files" archives as one library mod.
router.post('/upload', requirePermission('library.upload'), (req, res) => {
  upload.fields([
    { name: 'files', maxCount: 20 },
    { name: 'file', maxCount: 20 },
  ])(req, res, async (uploadError) => {
    if (uploadError) {
      const tooLarge = uploadError.code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 400).json({
        error: tooLarge ? 'The selected file exceeds the 1 GB upload limit.' : uploadError.message,
      });
    }

    const files = collectedUploads(req);
    try {
      if (!files.length) return res.status(400).json({ error: 'No file uploaded' });
      const result = await modManager.uploadMod(files, req.body);
      res.status(201).json(result);
    } catch (err) {
      unlinkUploads(files);
      res.status(400).json({ error: err.message });
    }
  });
});

router.post('/import-curseforge', requirePermission('library.import_curseforge'), async (req, res) => {
  req.setTimeout(20 * 60 * 1000);
  res.setTimeout(20 * 60 * 1000);
  try {
    const result = await curseforgeImporter.importFromUrl(req.body?.url);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/import-mcpedl', requirePermission('library.import_mcpedl'), async (req, res) => {
  req.setTimeout(20 * 60 * 1000);
  res.setTimeout(20 * 60 * 1000);
  try {
    const result = await mcpedlImporter.importFromUrl(req.body?.url);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', requirePermission('library.edit_metadata'), (req, res) => {
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
        loader: req.body?.loader,
      }, req.file || null);
      res.json(result);
    } catch (err) {
      if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      res.status(400).json({ error: err.message });
    }
  });
});

router.post('/:id/files', requirePermission('library.add_file'), (req, res) => {
  upload.fields([
    { name: 'files', maxCount: 20 },
    { name: 'file', maxCount: 20 },
  ])(req, res, async (uploadError) => {
    if (uploadError) {
      const tooLarge = uploadError.code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 400).json({
        error: tooLarge ? 'The selected file exceeds the 1 GB upload limit.' : uploadError.message,
      });
    }
    const files = collectedUploads(req);
    try {
      if (!files.length) return res.status(400).json({ error: 'No file uploaded' });
      const result = await modManager.addFilesToMod(req.params.id, files, req.body);
      res.json(result);
    } catch (err) {
      unlinkUploads(files);
      res.status(err.status || 400).json({ error: err.message });
    }
  });
});

router.delete('/:id/files', requirePermission('library.remove_file'), async (req, res) => {
  try {
    const uninstallFromServers = req.query.uninstallFromAll === '1' || req.query.uninstallFromAll === 'true'
      || req.body?.uninstallFromServers === true || req.body?.uninstallFromAll === true;
    const result = await modManager.deleteModFile(req.params.id, {
      sha256: req.body?.sha256 || req.query.sha256,
      name: req.body?.name || req.query.name,
      uninstallFromServers,
    });
    res.json(result || { success: true });
  } catch (err) {
    const status = err.status || 400;
    res.status(status).json({
      error: err.message,
      code: err.code,
      servers: err.servers || [],
    });
  }
});

router.get('/:id/thumbnail', requirePermission('library.view_files'), async (req, res) => {
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
router.delete('/:id', requirePermission('library.delete_entry'), async (req, res) => {
  try {
    const uninstallFromServers = req.query.uninstallFromAll === '1' || req.query.uninstallFromAll === 'true';
    await modManager.deleteMod(req.params.id, { uninstallFromServers });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get available mods for a server (not yet installed)
router.get('/available/:serverId', resolveServerResource('serverId'), requireServerVisible, requireServerPermission('servers.mods.view'), async (req, res) => {
  try {
    const mods = await modManager.getAvailableMods(req.params.serverId);
    res.json(mods);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get installed mods for a server
router.get('/installed/:serverId', resolveServerResource('serverId'), requireServerVisible, requireServerPermission('servers.mods.view'), async (req, res) => {
  try {
    const mods = await modManager.getInstalledMods(req.params.serverId);
    res.json(mods);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Install mod to server
router.post('/:modId/install/:serverId', resolveServerResource('serverId'), requireServerVisible, requireServerPermission('servers.mods.install'), async (req, res) => {
  try {
    await modManager.installModToServer(req.params.serverId, req.params.modId, {
      fileSha256: req.body?.fileSha256,
      override: false,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Uninstall mod from server
router.delete('/:modId/uninstall/:serverId', resolveServerResource('serverId'), requireServerVisible, requireServerPermission('servers.mods.remove'), async (req, res) => {
  try {
    await modManager.uninstallModFromServer(req.params.serverId, req.params.modId);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ========== MOD CATALOG ==========

router.get('/catalog/settings', requirePermission('catalog.view'), async (req, res) => {
  try {
    res.json({ multiFileMode: require('../services/settingsStore').getMultiFileMode() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/catalog/multi-file-mode', requirePermission('catalog.view'), (req, res) => {
  try {
    res.json({ multiFileMode: require('../services/settingsStore').getMultiFileMode() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/catalog/multi-file-mode', requirePermission('catalog.change_file_handling'), (req, res) => {

  try {
    res.json(catalog.setMultiFileMode(req.body?.mode));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/catalog/git/status', requirePermission('catalog.view'), (req, res) => {
  res.json(gitCatalog.getSyncStatus());
});

router.post('/catalog/git/sync', requirePermission('catalog.git.sync'), async (req, res) => {
  try {
    if (!gitCatalog.canSync()) {
      return res.status(400).json({
        error: 'Save Git Catalog plugin settings with the catalog enabled and an access token before syncing.',
      });
    }
    gitCatalog.startSync('manual').catch(() => {});
    res.status(202).json(gitCatalog.getSyncStatus());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/catalog/git/thumbnail/:slug', requirePermission('catalog.view'), async (req, res) => {
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

router.get('/catalog/file/thumbnail/:kind/:slug', requirePermission('catalog.view'), async (req, res) => {
  try {
    const filePath = fileCatalog.getThumbnailPath(req.params.kind, req.params.slug);
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

router.get('/catalog/search', requirePermission('catalog.search'), async (req, res) => {
  try {
    const result = await catalog.searchMods(req.query.q || '', {
      category: req.query.category,
      pageSize: parseInt(req.query.pageSize) || 40,
      page: parseInt(req.query.page) || 1,
      sortBy: req.query.sortBy || 'relevancy',
      source: req.query.source || 'all',
      provider: req.query.provider || '',
      edition: req.query.edition || 'all',
      gameVersions: req.query.gameVersions,
      loader: req.query.loader || '',
      environment: req.query.environment || '',
    });
    res.json(result);
  } catch (err) {
    const body = { error: err.message };
    if (err.code) body.code = err.code;
    if (err.loaderId) body.loaderId = err.loaderId;
    res.status(err.status || 500).json(body);
  }
});

router.get('/catalog/filter-availability', requirePermission('catalog.view'), (req, res) => {
  try {
    res.json(catalog.listFilterAvailability());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
});

router.get('/catalog/providers', requirePermission('catalog.view'), async (req, res) => {
  try {
    res.json(catalog.listProviders());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/catalog/categories', requirePermission('catalog.view'), async (req, res) => {
  try {
    const categories = await catalog.getCategories({
      edition: req.query.edition || 'all',
      provider: req.query.provider || '',
      source: req.query.source || 'all',
    });
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/catalog/download/:slug', requirePermission('catalog.download_to_library'), async (req, res) => {
  try {
    if (req.body?.fileId || req.body?.version || req.body?.fileIds) {
      assertPermission(req, 'catalog.select_download_version');
    }
    const result = await catalog.downloadMod(req.params.slug, req.body || {});
    res.json(result);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
});

router.get('/catalog/:slug', requirePermission('catalog.view_details'), async (req, res) => {
  try {
    const details = await catalog.getDetails(req.params.slug, req.query);
    if (!details) return res.status(404).json({ error: 'Mod not found' });
    res.json(details);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
