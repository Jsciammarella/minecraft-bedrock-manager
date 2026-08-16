const path = require('path');

const ARCHIVE_EXTS = ['.mcaddon', '.mcpack', '.mcworld', '.zip', '.mctemplate'];
const STRUCTURE_EXTS = ['.mcstructure'];
const IMPORT_EXTS = [...ARCHIVE_EXTS, ...STRUCTURE_EXTS];

function extOf(filePath) {
  return path.extname(filePath || '').toLowerCase();
}

function isArchiveExt(ext) {
  return ARCHIVE_EXTS.includes(String(ext || '').toLowerCase());
}

function isStructureExt(ext) {
  return STRUCTURE_EXTS.includes(String(ext || '').toLowerCase());
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
    default:
      return fallback;
  }
}

function unsupportedMessage(ext) {
  return `Unsupported file type ${ext || '(none)'}. Use ${IMPORT_EXTS.join(', ')}.`;
}

module.exports = {
  ARCHIVE_EXTS,
  STRUCTURE_EXTS,
  IMPORT_EXTS,
  extOf,
  isArchiveExt,
  isStructureExt,
  isImportExt,
  typeFromExt,
  unsupportedMessage,
};
