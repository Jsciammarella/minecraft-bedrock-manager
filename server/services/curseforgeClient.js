const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const db = require('../db/connection');
const logger = require('./logger');
const modManager = require('./modManager');
const settingsStore = require('./settingsStore');

const CURSEFORGE_API = 'https://api.curseforge.com';
const MINECRAFT_BEDROCK_GAME_ID = 1132; // Minecraft Bedrock Edition

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
      version = ''
    } = options;

    // Build search URL - CurseForge web scraping fallback
    try {
      return await this.searchViaAPI(query, { category, pageSize, page, sortBy, version });
    } catch (err) {
      logger.warn(`CurseForge API search failed, using web fallback: ${err.message}`);
      return await this.searchViaWeb(query, { category, pageSize, page, sortBy });
    }
  }

  async searchViaAPI(query, options) {
    if (!this.apiKey) {
      throw new Error('CurseForge API key not configured');
    }

    const params = {
      gameId: MINECRAFT_BEDROCK_GAME_ID,
      pageSize: options.pageSize,
      index: (options.page - 1) * options.pageSize,
      sortField: this.getSortField(options.sortBy),
      sortOrder: 'desc',
    };

    if (query) params.searchFilter = query;
    try {
      const taxonomy = await this.getApiTaxonomy();
      const requested = options.category || 'addons';
      const match = taxonomy.find(item =>
        (item.slug || item.name?.toLowerCase().replace(/\s+/g, '-')) === requested
      );
      if (match?.isClass) params.classId = match.id;
      else if (match) {
        params.categoryId = match.id;
        if (match.classId) params.classId = match.classId;
      }
    } catch (err) {
      logger.warn(`Could not load CurseForge taxonomy: ${err.message}`);
      params.classId = 9137;
    }

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
    const browseClasses = new Set(['addons', 'maps', 'texture-packs', 'scripts', 'skins']);
    const projectClass = browseClasses.has(options.category) ? options.category : 'addons';
    const params = new URLSearchParams({
      class: projectClass,
      page: String(options.page || 1),
      pageSize: String(options.pageSize || 20),
      sortBy: options.sortBy || 'relevancy',
    });

    if (query) params.set('filter', query);
    if (options.category && !browseClasses.has(options.category)) params.set('categories', options.category);

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
    return data.map(item => ({
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
      projectClass: this.projectClassFromItem(item),
      websiteUrl: item.links?.websiteUrl || `https://www.curseforge.com/minecraft-bedrock/addons/${item.slug}`,
    }));
  }

  async downloadViaAPI(slug, projectClass, serverId, { modId, fileId }) {
    const headers = { 'X-API-Key': this.apiKey };
    const [modResponse, fileResponse, urlResponse] = await Promise.all([
      axios.get(`${CURSEFORGE_API}/v1/mods/${modId}`, { headers, timeout: 10000 }),
      axios.get(`${CURSEFORGE_API}/v1/mods/${modId}/files/${fileId}`, { headers, timeout: 10000 }),
      axios.get(`${CURSEFORGE_API}/v1/mods/${modId}/files/${fileId}/download-url`, { headers, timeout: 10000 }),
    ]);
    const item = modResponse.data.data;
    const file = fileResponse.data.data;
    const downloadUrl = urlResponse.data.data || file.downloadUrl;
    if (!downloadUrl) throw new Error('CurseForge did not provide a download URL for this file');

    const downloadResponse = await axios.get(downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 60000,
      headers,
    });
    const filename = modManager.sanitizeFilename(file.fileName || `${slug}.mcaddon`);
    const filePath = path.join(__dirname, '../../data/mods', filename);
    fs.writeFileSync(filePath, Buffer.from(downloadResponse.data));

    const result = db.prepare(`
      INSERT OR IGNORE INTO mods
        (name, slug, type, version, description, author, thumbnail, file_path, file_size, curseforge_id, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'curseforge')
    `).run(
      item.name,
      slug,
      this.typeFromProjectClass(projectClass),
      file.displayName || '1.0.0',
      item.summary || '',
      item.authors?.[0]?.name || 'Unknown',
      item.logo?.thumbnailUrl || item.logo?.url || '',
      filePath,
      fs.statSync(filePath).size,
      String(modId)
    );
    const storedId = result.changes
      ? result.lastInsertRowid
      : db.prepare('SELECT id FROM mods WHERE curseforge_id = ?').get(String(modId))?.id;
    if (serverId && storedId) await modManager.installModToServer(serverId, storedId);
    return { success: true, modId: storedId, name: item.name };
  }

  projectClassFromItem(item) {
    const url = item.links?.websiteUrl || '';
    return url.match(/\/minecraft-bedrock\/(addons|maps|texture-packs|scripts|skins)\//)?.[1] || 'addons';
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
    return 9137;
  }
}

module.exports = new CurseForgeClient();
