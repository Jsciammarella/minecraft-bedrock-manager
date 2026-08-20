const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const db = require('../db/connection');
const logger = require('./logger');
const modManager = require('./modManager');
const settingsStore = require('./settingsStore');
const packFiles = require('./packFiles');
const modArchives = require('./modArchives');

const CURSEFORGE_API = 'https://api.curseforge.com';
// CurseForge game 1132 is not Minecraft Bedrock; searches against it return an empty catalog.
const MINECRAFT_BEDROCK_GAME_ID = 78022;
const BEDROCK_CLASS_IDS = {
  addons: 4984,
  maps: 6913,
  'texture-packs': 6929,
  scripts: 6940,
  skins: 6925,
};
const BEDROCK_CLASS_SLUGS = Object.fromEntries(
  Object.entries(BEDROCK_CLASS_IDS).map(([slug, id]) => [String(id), slug])
);
const MINECRAFT_BEDROCK_ADDONS_CLASS_ID = BEDROCK_CLASS_IDS.addons;

class CurseForgeClient {
  constructor() {
    this.cache = new Map();
    this.cacheTTL = 5 * 60 * 1000; // 5 minutes
  }

  get apiKey() {
    return settingsStore.getCurseForgeApiKey();
  }

  async searchMods(query = '', options = {}) {
    const {
      category = '',
      pageSize = 20,
      page = 1,
      sortBy = 'relevancy',
      version = '',
      offset,
    } = options;
    const resolvedOffset = offset != null ? Number(offset) : (page - 1) * pageSize;
    const resolvedPage = Math.floor(Math.max(0, resolvedOffset) / pageSize) + 1;

    // Build search URL - CurseForge web scraping fallback
    try {
      return await this.searchViaAPI(query, {
        category, pageSize, page: resolvedPage, sortBy, version, offset: resolvedOffset,
      });
    } catch (err) {
      logger.warn(`CurseForge API search failed, using web fallback: ${err.message}`);
      return await this.searchViaWeb(query, { category, pageSize, page: resolvedPage, sortBy });
    }
  }

  async searchViaAPI(query, options) {
    if (!this.apiKey) {
      throw new Error('CurseForge API key not configured');
    }

    const params = {
      gameId: MINECRAFT_BEDROCK_GAME_ID,
      pageSize: options.pageSize,
      index: options.offset != null ? options.offset : (options.page - 1) * options.pageSize,
      sortField: this.getSortField(options.sortBy),
      sortOrder: 'desc',
    };

    if (query) params.searchFilter = query;
    await this.applyCategoryFilter(params, options.category);

    const headers = { 'X-API-Key': this.apiKey };
    const response = await axios.get(`${CURSEFORGE_API}/v1/mods/search`, { params, headers, timeout: 10000 });

    return {
      results: this.formatResults(response.data.data || []),
      total: response.data.pagination?.totalCount || 0,
      page: options.page,
    };
  }

  async searchViaWeb(query, options) {
    // Fallback: scrape CurseForge web page
    const baseUrl = 'https://www.curseforge.com/minecraft-bedrock/search';
    const params = new URLSearchParams({
      page: String(options.page || 1),
      pageSize: String(options.pageSize || 20),
      sortBy: options.sortBy || 'relevancy',
    });

    if (query) params.set('filter', query);
    if (BEDROCK_CLASS_IDS[options.category]) {
      params.set('class', options.category);
    } else if (options.category) {
      params.set('class', 'addons');
      params.set('categories', options.category);
    }

    try {
      const response = await axios.get(`${baseUrl}?${params}`, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      return this.parseSearchResults(response.data, options.page || 1, options.pageSize || 20);
    } catch (err) {
      logger.error(`Web search failed: ${err.message}`);
      if (err.response?.status === 403 && !this.apiKey) {
        throw new Error('CurseForge blocks automated catalog requests. Set CURSEFORGE_API_KEY to enable the catalog.');
      }
      throw new Error(`CurseForge catalog is unavailable: ${err.message}`);
    }
  }

  async applyCategoryFilter(params, category) {
    const requested = String(category || '').trim();
    if (!requested) return;

    try {
      const taxonomy = await this.getApiTaxonomy();
      const match = taxonomy.find(item =>
        (item.slug || item.name?.toLowerCase().replace(/\s+/g, '-')) === requested
      );
      if (match?.isClass) {
        params.classId = match.id;
      } else if (match) {
        params.categoryId = match.id;
        if (match.classId) params.classId = match.classId;
      } else if (BEDROCK_CLASS_IDS[requested]) {
        params.classId = BEDROCK_CLASS_IDS[requested];
      }
    } catch (err) {
      logger.warn(`Could not load CurseForge taxonomy: ${err.message}`);
      params.classId = BEDROCK_CLASS_IDS[requested] || MINECRAFT_BEDROCK_ADDONS_CLASS_ID;
    }
  }

  async getApiTaxonomy() {
    const cacheKey = 'api-taxonomy';
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.time < this.cacheTTL) return cached.value;
    const response = await axios.get(`${CURSEFORGE_API}/v1/categories`, {
      params: { gameId: MINECRAFT_BEDROCK_GAME_ID },
      headers: { 'X-API-Key': this.apiKey },
      timeout: 10000,
    });
    const value = response.data.data || [];
    this.cache.set(cacheKey, { time: Date.now(), value });
    return value;
  }

  async getModDetails(slug, projectClass = 'addons') {
    const safeClass = this.sanitizeProjectClass(projectClass);
    // Try to get details from CurseForge
    try {
      const response = await axios.get(
        `https://www.curseforge.com/minecraft-bedrock/${safeClass}/${encodeURIComponent(slug)}`,
        {
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        }
      );

      return this.parseModDetails(response.data, slug, safeClass);
    } catch (err) {
      logger.error(`Failed to get mod details: ${err.message}`);
      return null;
    }
  }

  async downloadMod(slug, projectClass = 'addons', serverId = null, apiFile = {}) {
    const modPath = path.join(__dirname, '../../data/mods');
    const safeClass = this.sanitizeProjectClass(projectClass);
    
    try {
      if (this.apiKey && apiFile.modId && apiFile.fileId) {
        return await this.downloadViaAPI(slug, safeClass, serverId, apiFile);
      }
      // Get mod page
      const response = await axios.get(
        `https://www.curseforge.com/minecraft-bedrock/${safeClass}/${encodeURIComponent(slug)}`,
        {
          timeout: 15000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        }
      );

      // Parse download link
      let downloadUrl = this.extractDownloadUrl(response.data, safeClass, slug);
      if (!downloadUrl) {
        throw new Error('Could not find download link');
      }

      // CurseForge project pages link to an intermediate /download/{fileId}
      // page. That page contains the CDN URL used by the browser countdown.
      if (downloadUrl.includes('/download/')) {
        const downloadPage = await axios.get(downloadUrl, {
          timeout: 15000,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        downloadUrl = this.extractCdnDownloadUrl(downloadPage.data) || downloadUrl;
      }

      // Download the file
      const downloadResponse = await axios.get(downloadUrl, {
        responseType: 'arraybuffer',
        timeout: 60000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      // Save file
      const filename = this.extractFilename(downloadUrl) || `${slug}.mcaddon`;
      const safeName = modManager.sanitizeFilename(filename);
      const filePath = path.join(modPath, safeName);

      fs.writeFileSync(filePath, Buffer.from(downloadResponse.data));

      // Get mod info from page
      const modInfo = this.parseModDetails(response.data, slug, safeClass);

      // Add to database
      const insert = db.prepare(`
        INSERT OR IGNORE INTO mods (name, slug, type, description, author, thumbnail, file_path, file_size, curseforge_id, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'curseforge')
      `);

      const fileSize = fs.statSync(filePath).size;
      const result = insert.run(
        modInfo?.name || slug,
        slug,
        modInfo?.type || 'addon',
        modInfo?.description || '',
        modInfo?.author || 'Unknown',
        modInfo?.thumbnail || '',
        filePath,
        fileSize,
        slug
      );

      // Auto-install to server if specified
      if (serverId) {
        await modManager.installModToServer(serverId, result.lastInsertRowid);
      }

      logger.info(`Downloaded mod from CurseForge: ${slug}`);
      return { success: true, modId: result.lastInsertRowid, name: modInfo?.name || slug };
    } catch (err) {
      logger.error(`Failed to download mod: ${err.message}`);
      throw new Error(`Download failed: ${err.message}`);
    }
  }

  async getCategories() {
    return [
      { id: 'addons', name: 'Addons', description: 'Behavior and content addons' },
      { id: 'texture-packs', name: 'Texture Packs', description: 'Visual enhancements' },
      { id: 'maps', name: 'Maps', description: 'World maps and levels' },
      { id: 'scripts', name: 'Scripts', description: 'Script addons' },
      { id: 'skins', name: 'Skins', description: 'Player skins' },
      { id: 'utility', name: 'Utility', description: 'Utility addons' },
      { id: 'vanilla', name: 'Vanilla+', description: 'Vanilla enhancements' },
      { id: 'survival', name: 'Survival', description: 'Survival addons' },
      { id: 'technology', name: 'Technology', description: 'Tech addons' },
      { id: 'magic', name: 'Magic', description: 'Magic addons' },
      { id: 'multiplayer', name: 'Multiplayer', description: 'Multiplayer addons' },
    ];
  }

  // ========== PARSING HELPERS ==========

  formatResults(data) {
    return data.map(item => {
      const projectClass = this.projectClassFromItem(item);
      return {
        id: item.id,
        curseforgeId: item.id,
        fileId: item.mainFileId || item.latestFiles?.[0]?.id || null,
        name: item.name,
        slug: item.slug,
        description: item.summary || item.description || '',
        author: item.authors?.[0]?.name || item.author?.name || 'Unknown',
        thumbnail: item.logo?.thumbnailUrl || item.logo?.url || item.thumbnailUrl || '',
        downloads: item.downloadCount || 0,
        dateUpdated: item.dateModified || item.dateUpdated,
        type: this.inferTypeFromCategories(item.categories || []),
        categories: item.categories || [],
        projectClass,
        websiteUrl: item.links?.websiteUrl || `https://www.curseforge.com/minecraft-bedrock/${projectClass}/${item.slug}`,
      };
    });
  }

  async downloadViaAPI(slug, projectClass, serverId, { modId, fileId }) {
    const headers = { 'X-API-Key': this.apiKey };
    const modResponse = await axios.get(`${CURSEFORGE_API}/v1/mods/${modId}`, { headers, timeout: 10000 });
    const item = modResponse.data.data;
    const copied = await this.downloadLatestArchives(modId, slug, fileId);
    if (!copied.length) throw new Error('CurseForge did not provide a downloadable Bedrock file');

    const primary = copied[0];
    const extraFiles = modArchives.serializeExtraFiles(copied.slice(1));
    const fileSize = copied.reduce((sum, file) => sum + (file.size || 0), 0);
    const result = db.prepare(`
      INSERT OR IGNORE INTO mods
        (name, slug, type, version, description, author, thumbnail, file_path, file_size, extra_files, curseforge_id, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'curseforge')
    `).run(
      item.name,
      slug,
      this.typeFromProjectClass(projectClass),
      copied[0].version || '1.0.0',
      item.summary || '',
      item.authors?.[0]?.name || 'Unknown',
      item.logo?.thumbnailUrl || item.logo?.url || '',
      primary.path,
      fileSize,
      extraFiles,
      String(modId)
    );
    const storedId = result.changes
      ? result.lastInsertRowid
      : db.prepare('SELECT id FROM mods WHERE curseforge_id = ?').get(String(modId))?.id;
    if (storedId && !result.changes) {
      db.prepare(`
        UPDATE mods
        SET extra_files = ?, file_path = ?, file_size = ?, downloaded_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(extraFiles, primary.path, fileSize, storedId);
    }
    if (serverId && storedId) await modManager.installModToServer(serverId, storedId);
    return { success: true, modId: storedId, name: item.name, files: copied.map((file) => file.name) };
  }

  async findModIdBySlug(slug, projectClass = 'addons') {
    if (!this.apiKey || !slug) return null;
    const headers = { 'X-API-Key': this.apiKey };
    const params = {
      gameId: MINECRAFT_BEDROCK_GAME_ID,
      slug,
      pageSize: 5,
    };
    if (BEDROCK_CLASS_IDS[projectClass]) params.classId = BEDROCK_CLASS_IDS[projectClass];
    const response = await axios.get(`${CURSEFORGE_API}/v1/mods/search`, {
      params,
      headers,
      timeout: 10000,
    });
    const match = (response.data.data || []).find((item) => item.slug === slug);
    return match?.id || null;
  }

  async downloadLatestArchives(modId, slug, preferredFileId) {
    const headers = { 'X-API-Key': this.apiKey };
    const files = this.latestFilesByExtension(await this.listModFiles(modId, headers), preferredFileId);
    const copied = [];
    for (const file of files) {
      const urlResponse = await axios.get(
        `${CURSEFORGE_API}/v1/mods/${modId}/files/${file.id}/download-url`,
        { headers, timeout: 10000 }
      );
      const downloadUrl = urlResponse.data.data || file.downloadUrl;
      if (!downloadUrl) throw new Error(`CurseForge did not provide a download URL for ${file.fileName || file.id}`);
      const downloadResponse = await axios.get(downloadUrl, {
        responseType: 'arraybuffer',
        timeout: 120000,
        headers,
      });
      const filename = modManager.getAvailableFilename(
        modManager.sanitizeFilename(file.fileName || `${slug}${path.extname(file.fileName || '') || '.mcaddon'}`)
      );
      const filePath = path.join(__dirname, '../../data/mods', filename);
      fs.writeFileSync(filePath, Buffer.from(downloadResponse.data));
      copied.push({
        path: filePath,
        kind: packFiles.typeFromExt(file.fileName || filePath),
        size: fs.statSync(filePath).size,
        name: path.basename(filePath),
        version: file.displayName || '1.0.0',
      });
    }
    return copied;
  }

  async listModFiles(modId, headers) {
    const files = [];
    let index = 0;
    for (let page = 0; page < 10; page += 1) {
      const response = await axios.get(`${CURSEFORGE_API}/v1/mods/${modId}/files`, {
        params: { index, pageSize: 50 },
        headers,
        timeout: 15000,
      });
      const batch = response.data.data || [];
      files.push(...batch);
      const total = response.data.pagination?.totalCount || files.length;
      index += batch.length;
      if (!batch.length || index >= total) break;
    }
    return files;
  }

  latestFilesByExtension(files, preferredFileId) {
    const byExt = new Map();
    for (const file of files || []) {
      const ext = path.extname(file.fileName || '').toLowerCase();
      if (!packFiles.isImportExt(ext)) continue;
      const date = new Date(file.fileDate || 0).getTime();
      const prev = byExt.get(ext);
      if (!prev || date > prev.date) byExt.set(ext, { file, date });
    }
    const selected = [...byExt.values()].map((item) => item.file);
    if (!selected.length && preferredFileId) {
      const fallback = (files || []).find((file) => String(file.id) === String(preferredFileId));
      if (fallback) selected.push(fallback);
    }
    selected.sort((a, b) => {
      const rank = { '.mcaddon': 0, '.zip': 1, '.mcpack': 2, '.mcworld': 3, '.mctemplate': 4, '.mcstructure': 5 };
      return (rank[path.extname(a.fileName || '').toLowerCase()] ?? 9)
        - (rank[path.extname(b.fileName || '').toLowerCase()] ?? 9);
    });
    return selected;
  }

  projectClassFromItem(item) {
    const url = item.links?.websiteUrl || '';
    const fromUrl = url.match(/\/minecraft-bedrock\/(addons|maps|texture-packs|scripts|skins)\//)?.[1];
    if (fromUrl) return fromUrl;
    return BEDROCK_CLASS_SLUGS[String(item.classId)] || 'addons';
  }

  parseSearchResults(html, page = 1, pageSize = 20) {
    const $ = cheerio.load(html);
    const results = [];

    const projectPath = /^\/minecraft-bedrock\/(addons|maps|texture-packs|scripts|skins)\/([^/?#]+)\/?$/;
    $('a[href]').each((_, element) => {
      if (results.length >= pageSize) return;
      const href = $(element).attr('href') || '';
      const match = href.match(projectPath);
      if (!match) return;
      const [, projectClass, slug] = match;
      if (results.some(result => result.slug === slug && result.projectClass === projectClass)) return;

      const name = $(element).text().replace(/\s+/g, ' ').trim();
      if (!name || name.toLowerCase() === 'view' || name.toLowerCase() === 'download') return;

      let card = $(element);
      for (let depth = 0; depth < 6 && card.length; depth += 1) {
        const text = card.text();
        if (card.find('img').length && /\bBy\b/i.test(text) && /download/i.test(text)) break;
        card = card.parent();
      }
      const cardText = card.text().replace(/\s+/g, ' ').trim();
      const image = card.find('img').first();
      const authorLink = card.find('a[href*="/members/"], a[href*="/author/"]').first();
      const paragraphs = card.find('p').map((__, p) => $(p).text().replace(/\s+/g, ' ').trim()).get();
      const description = paragraphs.find(text => text.length > 20 && !text.startsWith('By ')) || '';
      const downloadText = cardText.match(/\b([\d,.]+\s*[KMB]?)\b/i)?.[1] || '0';

      results.push({
        id: `${projectClass}:${slug}`,
        name,
        slug,
        projectClass,
        websiteUrl: `https://www.curseforge.com${href}`,
        description,
        author: authorLink.text().replace(/\s+/g, ' ').trim() || 'Unknown',
        thumbnail: image.attr('src') || image.attr('data-src') || '',
        downloads: this.parseCompactNumber(downloadText),
        type: this.typeFromProjectClass(projectClass),
      });
    });

    const totalText = $('body').text().replace(/\s+/g, ' ');
    const totalMatch = totalText.match(/([\d,]+\+?)\s+Projects/i);
    const total = totalMatch ? parseInt(totalMatch[1].replace(/\D/g, ''), 10) : results.length;
    return { results, total, page };
  }

  parseModDetails(html, slug, projectClass = 'addons') {
    try {
      const nameMatch = html.match(/<h1[^>]*>([^<]{3,100})</);
      const descMatch = html.match(/"description":"([^"]{10,500})"/s) || html.match(/<p[^>]*>([^<]{10,500})</);
      const authorMatch = html.match(/"authorName":"([^"]+)"/) || html.match(/by\s+([^<,]+)/i);
      const thumbMatch = html.match(/"thumbnailUrl":"([^"]+)"/) || html.match(/src="([^"]+\.jpg[^"]*)"/);
      const downloadsMatch = html.match(/"totalDownloads":(\d+)/);
      const versionMatch = html.match(/"version":\s*"([^"]+)"/);

      return {
        name: nameMatch?.[1]?.trim() || slug,
        slug,
        projectClass,
        websiteUrl: `https://www.curseforge.com/minecraft-bedrock/${projectClass}/${slug}`,
        description: descMatch?.[1]?.trim() || '',
        author: authorMatch?.[1]?.trim() || 'Unknown',
        thumbnail: thumbMatch?.[1] || '',
        downloads: parseInt(downloadsMatch?.[1] || '0'),
        version: versionMatch?.[1] || '1.0.0',
        type: this.typeFromProjectClass(projectClass),
      };
    } catch {
      return { name: slug, slug, projectClass, description: '', author: 'Unknown', type: this.typeFromProjectClass(projectClass) };
    }
  }

  extractDownloadUrl(html, projectClass, slug) {
    // Look for download links in the HTML
    const patterns = [
      /href="([^"]*\/minecraft-bedrock\/(?:addons|maps|texture-packs|scripts|skins)\/[^"]*\/download\/\d+[^"]*)"/,
      /"downloadUrl":"([^"]+)"/,
      /href="([^"]*\.mca?dd?on[^"]*)"/,
      /href="([^"]*\.mcpack[^"]*)"/,
      /href="([^"]*\.mcworld[^"]*)"/,
      /href="([^"]*\.zip[^"]*download[^"]*)"/,
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        let url = match[1];
        if (url.startsWith('/')) {
          url = `https://www.curseforge.com${url}`;
        }
        return url.replace(/\\u002F/g, '/').replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
      }
    }
    return null;
  }

  extractCdnDownloadUrl(html) {
    const patterns = [
      /https:\/\/mediafilez?\.forgecdn\.net\/files\/[^"]+/i,
      /https:\/\/edge\.forgecdn\.net\/files\/[^"]+/i,
      /"downloadUrl":"([^"]+)"/i,
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      const url = match?.[1] || match?.[0];
      if (url) return url.replace(/\\u002F/g, '/').replace(/\\u0026/g, '&').replace(/\\/g, '');
    }
    return null;
  }

  sanitizeProjectClass(projectClass) {
    const allowed = new Set(['addons', 'maps', 'texture-packs', 'scripts', 'skins']);
    return allowed.has(projectClass) ? projectClass : 'addons';
  }

  typeFromProjectClass(projectClass) {
    const map = { 'texture-packs': 'texture_pack', maps: 'world', skins: 'skin' };
    return map[projectClass] || 'addon';
  }

  parseCompactNumber(value) {
    const text = String(value || '0').replace(/,/g, '').trim().toUpperCase();
    const number = parseFloat(text) || 0;
    const multiplier = text.endsWith('B') ? 1e9 : text.endsWith('M') ? 1e6 : text.endsWith('K') ? 1e3 : 1;
    return Math.round(number * multiplier);
  }

  extractFilename(url) {
    const match = url.match(/[^\/]+\.((mca?dd?on)|(mcpack)|(mcworld)|(zip))/i);
    return match ? match[0] : null;
  }

  inferTypeFromCategories(categories) {
    const categoryNames = categories.map(c => (c.name || c).toLowerCase());
    if (categoryNames.some(c => c.includes('texture'))) return 'texture_pack';
    if (categoryNames.some(c => c.includes('map'))) return 'world';
    if (categoryNames.some(c => c.includes('skin'))) return 'skin';
    return 'addon';
  }

  inferTypeFromSlug(slug) {
    const lower = slug.toLowerCase();
    if (lower.includes('texture') || lower.includes('skin')) return 'texture_pack';
    if (lower.includes('map') || lower.includes('world')) return 'world';
    return 'addon';
  }

  getSortField(sortBy) {
    const map = { relevancy: 7, popularity: 2, lastUpdated: 3, totalDownloads: 6 };
    return map[sortBy] || 7;
  }

  getCategoryId(category) {
    // This would map to actual CurseForge category IDs
    // For now return a generic value
    return BEDROCK_CLASS_IDS[category] || MINECRAFT_BEDROCK_ADDONS_CLASS_ID;
  }
}

module.exports = new CurseForgeClient();
