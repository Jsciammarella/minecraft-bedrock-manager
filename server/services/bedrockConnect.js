const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const axios = require('axios');
const logger = require('./logger');

const execFileAsync = promisify(execFile);

const REPO = 'Pugmatt/BedrockConnect';
const ASSET_NAME = 'BedrockConnect-1.0-SNAPSHOT.jar';
const MAX_STORED_VERSIONS = 10;
const DEFAULT_PORT = 19132;
const KIND = 'bedrock_connect';
const DISPLAY_NAME = 'Bedrock Connect';
const RELEASES_DIR = path.join(__dirname, '../../data/bedrock-connect/releases');
const INDEX_PATH = path.join(__dirname, '../../data/bedrock-connect/index.json');
const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'minecraft-bedrock-manager',
  'X-GitHub-Api-Version': '2022-11-28',
};

function ensureDirs() {
  fs.mkdirSync(RELEASES_DIR, { recursive: true });
}

function readIndex() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  } catch {
    return { versions: [] };
  }
}

function writeIndex(index) {
  ensureDirs();
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
}

function jarPathFor(tag) {
  const safe = String(tag || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(RELEASES_DIR, `${safe}.jar`);
}

function listVersions() {
  const index = readIndex();
  return (index.versions || []).slice(0, MAX_STORED_VERSIONS);
}

function latestStoredVersion() {
  return listVersions()[0] || null;
}

function findAsset(release) {
  const assets = release?.assets || [];
  return assets.find(asset => asset.name === ASSET_NAME)
    || assets.find(asset => /\.jar$/i.test(asset.name || ''));
}

async function fetchReleases(limit = 10) {
  const response = await axios.get(`https://api.github.com/repos/${REPO}/releases`, {
    params: { per_page: limit },
    headers: GITHUB_HEADERS,
    timeout: 20000,
  });
  return Array.isArray(response.data) ? response.data : [];
}

async function fetchLatestRelease() {
  const response = await axios.get(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: GITHUB_HEADERS,
    timeout: 20000,
  });
  return response.data;
}

async function downloadRelease(release) {
  const tag = release.tag_name || release.name;
  if (!tag) throw new Error('Bedrock Connect release is missing a version tag');
  const asset = findAsset(release);
  if (!asset?.browser_download_url) {
    throw new Error(`Bedrock Connect ${tag} does not include ${ASSET_NAME}`);
  }

  ensureDirs();
  const dest = jarPathFor(tag);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
    rememberVersion(tag, dest, release.published_at);
    return { tag, path: dest, downloaded: false };
  }

  const response = await axios.get(asset.browser_download_url, {
    responseType: 'arraybuffer',
    headers: { ...GITHUB_HEADERS, Accept: 'application/octet-stream' },
    timeout: 120000,
    maxRedirects: 5,
  });
  fs.writeFileSync(dest, Buffer.from(response.data));
  if (fs.statSync(dest).size < 1000) {
    fs.unlinkSync(dest);
    throw new Error(`Downloaded Bedrock Connect ${tag} was too small`);
  }
  rememberVersion(tag, dest, release.published_at);
  logger.info(`Downloaded Bedrock Connect ${tag}`);
  return { tag, path: dest, downloaded: true };
}

function rememberVersion(tag, filePath, publishedAt) {
  const index = readIndex();
  const versions = (index.versions || []).filter(item => item.tag !== tag);
  versions.unshift({
    tag,
    path: filePath,
    publishedAt: publishedAt || new Date().toISOString(),
    downloadedAt: new Date().toISOString(),
  });
  pruneVersions(versions);
  writeIndex({ versions });
}

function pruneVersions(versions) {
  const keep = versions.slice(0, MAX_STORED_VERSIONS);
  for (const extra of versions.slice(MAX_STORED_VERSIONS)) {
    try { fs.unlinkSync(extra.path); } catch { /* ignore */ }
  }
  versions.length = 0;
  versions.push(...keep);
}

async function syncLatest({ download = true } = {}) {
  const latest = await fetchLatestRelease();
  const tag = latest.tag_name || latest.name;
  if (download) await downloadRelease(latest);
  return {
    latestTag: tag,
    stored: listVersions(),
  };
}

async function ensureJarAvailable() {
  const stored = latestStoredVersion();
  if (stored && fs.existsSync(stored.path)) return stored;
  const downloaded = await downloadRelease(await fetchLatestRelease());
  return { tag: downloaded.tag, path: downloaded.path };
}

function installJarInto(serverDir, tag) {
  const versions = listVersions();
  const match = tag && tag !== 'latest'
    ? versions.find(item => item.tag === tag)
    : versions[0];
  if (!match || !fs.existsSync(match.path)) {
    throw new Error(tag ? `Bedrock Connect ${tag} is not in the local repository` : 'No Bedrock Connect JAR has been downloaded yet');
  }
  fs.mkdirSync(serverDir, { recursive: true });
  const dest = path.join(serverDir, ASSET_NAME);
  fs.copyFileSync(match.path, dest);
  fs.writeFileSync(path.join(serverDir, 'version.txt'), `${match.tag}\n`);
  return { tag: match.tag, jarPath: dest };
}

function installedJar(serverDir) {
  const dest = path.join(serverDir, ASSET_NAME);
  if (!fs.existsSync(dest)) return null;
  let tag = '';
  try { tag = fs.readFileSync(path.join(serverDir, 'version.txt'), 'utf8').trim(); } catch { /* ignore */ }
  return { tag, jarPath: dest };
}

async function assertJavaAvailable() {
  try {
    await execFileAsync('java', ['-version'], { timeout: 8000, windowsHide: true });
  } catch (err) {
    const text = [err.stderr, err.stdout, err.message].filter(Boolean).join('\n');
    if (/version/i.test(text)) return;
    throw new Error('Java 8 or newer is required to run Bedrock Connect. Install a JRE and restart the manager.');
  }
}

module.exports = {
  ASSET_NAME,
  DEFAULT_PORT,
  DISPLAY_NAME,
  KIND,
  MAX_STORED_VERSIONS,
  assertJavaAvailable,
  ensureJarAvailable,
  fetchLatestRelease,
  fetchReleases,
  installJarInto,
  installedJar,
  jarPathFor,
  listVersions,
  latestStoredVersion,
  syncLatest,
};
