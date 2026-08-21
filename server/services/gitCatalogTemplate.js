const fs = require('fs');
const path = require('path');

const STARTER_FILENAME = 'catalog-git.zip';
const STARTER_PATH = path.join(__dirname, '../assets/catalog-git.zip');

function buildStarterZip() {
  return fs.readFileSync(STARTER_PATH);
}

function starterFileNames() {
  const zip = buildStarterZip();
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  let offset = zip.readUInt32LE(eocd + 16);
  const names = [];
  while (offset + 46 <= zip.length && zip.readUInt32LE(offset) === 0x02014b50) {
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    names.push(zip.slice(offset + 46, offset + 46 + nameLength).toString('utf8'));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

module.exports = {
  STARTER_FILENAME,
  STARTER_PATH,
  buildStarterZip,
  starterFileNames,
};
