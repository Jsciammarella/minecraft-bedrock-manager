const path = require('path');

const ARCHIVE_EXTS = ['.mcaddon', '.mcpack', '.mcworld', '.zip', '.mctemplate'];
const STRUCTURE_EXTS = ['.mcstructure'];
const JAVA_EXTS = ['.jar'];
const IMPORT_EXTS = [...ARCHIVE_EXTS, ...STRUCTURE_EXTS, ...JAVA_EXTS];

function extOf(filePath) {
  return path.extname(filePath || '').toLowerCase();
}

function isArchiveExt(ext) {
  return ARCHIVE_EXTS.includes(String(ext || '').toLowerCase());
}

function isStructureExt(ext) {
  return STRUCTURE_EXTS.includes(String(ext || '').toLowerCase());
}

function isJavaExt(ext) {
  return JAVA_EXTS.includes(String(ext || '').toLowerCase());
}

function isImportExt(ext) {
  return IMPORT_EXTS.includes(String(ext || '').toLowerCase());
}

function typeFromExt(filePath, fallback = 'addon') {
  switch (extOf(filePath)) {
    case '.mcworld':
      return 'world';
    case '.mctemplate':
      return 'template';
    case '.mcstructure':
      return 'structure';
    case '.mcpack':
      return 'resource_pack';
    case '.mcaddon':
    case '.zip':
      return 'addon';
    case '.jar':
      return 'mod';
    default:
      return fallback;
  }
}

function unsupportedMessage(ext) {
  return `Unsupported file type ${ext || '(none)'}. Use ${IMPORT_EXTS.join(', ')}.`;
}

function fileChoices(filePaths) {
  const counts = new Map();
  for (const filePath of filePaths || []) {
    const name = path.basename(filePath || '');
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return (filePaths || []).map((filePath) => {
    const name = path.basename(filePath || '');
    const ext = extOf(filePath);
    return {
      id: counts.get(name) > 1 ? String(filePath).replace(/\\/g, '/') : name,
      name,
      type: typeFromExt(filePath),
      extension: ext,
    };
  });
}

function matchesFileChoice(filePath, selected) {
  if (!Array.isArray(selected) || !selected.length) return true;
  const ids = new Set(selected.map(String));
  const name = path.basename(filePath || '');
  const norm = String(filePath || '').replace(/\\/g, '/');
  return ids.has(name) || ids.has(norm) || ids.has(String(filePath));
}

module.exports = {
  ARCHIVE_EXTS,
  STRUCTURE_EXTS,
  JAVA_EXTS,
  isJavaExt,
  extOf,
  isArchiveExt,
  isStructureExt,
  isImportExt,
  typeFromExt,
  unsupportedMessage,
  fileChoices,
  matchesFileChoice,
};
