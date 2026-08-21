const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const STARTER_ROOT = 'file-catalog';
const STARTER_FILENAME = 'file-catalog-starter.zip';
const SAMPLE_THUMBNAIL = fs.readFileSync(path.join(__dirname, '../assets/example-thumbnail.png'));

const CATEGORIES = [
  {
    folder: 'addons',
    slug: 'example-addon',
    name: 'Example Addon',
    type: 'addon',
    archive: 'example-addon.mcaddon',
    categories: ['addons'],
    description: 'Replace this sample with your .mcaddon or .mcpack.',
  },
  {
    folder: 'maps',
    slug: 'example-map',
    name: 'Example Map',
    type: 'world',
    archive: 'example-map.mcworld',
    categories: ['maps'],
    description: 'Replace this sample with your .mcworld.',
  },
  {
    folder: 'texture-packs',
    slug: 'example-texture-pack',
    name: 'Example Texture Pack',
    type: 'texture_pack',
    archive: 'example-texture-pack.mcpack',
    categories: ['texture-packs'],
    description: 'Replace this sample with your .mcpack.',
  },
  {
    folder: 'skins',
    slug: 'example-skin',
    name: 'Example Skin',
    type: 'skin',
    archive: 'example-skin.mcpack',
    categories: ['skins'],
    description: 'Replace this sample with your skin pack.',
  },
  {
    folder: 'scripts',
    slug: 'example-script',
    name: 'Example Script',
    type: 'addon',
    archive: 'example-script.mcaddon',
    categories: ['scripts'],
    description: 'Replace this sample with your script addon.',
  },
];

function zipStore(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'));
    const crc = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const localFile = Buffer.concat([local, nameBuf, data]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(localFile);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += localFile.length;
  }
  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(locals.length, 8);
  end.writeUInt16LE(locals.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, end]);
}

function prettyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function starterReadme() {
  return `# File catalog starter

Extract this archive, then point **Mod Catalog → Settings → File Catalog** at the \`file-catalog\` folder. The example mods are labeled Example and should be deleted once your catalog is set up.

## Layout

\`\`\`text
README.md
catalog.json
example-mod/
  mod.json
  thumbnail.png
  example-addon.mcaddon
addons/
maps/
texture-packs/
skins/
scripts/
\`\`\`

Each category folder contains one example mod you can copy. Replace the empty pack files with real \`.mcaddon\`, \`.mcpack\`, \`.mcworld\`, \`.mctemplate\`, \`.mcstructure\`, or \`.zip\` archives.

## Files

- \`catalog.json\` — optional index. A string \`file\` or an array of archives is valid.
- \`mod.json\` — optional per-folder metadata. If you omit \`file\`, every pack in that folder is grouped as one catalog entry.
- \`thumbnail.png\` — optional card image (\`thumbnail.jpg\`, \`logo.png\`, \`icon.png\`, and \`pack_icon.png\` also work).

See \`docs/file-mod-catalog.md\` and \`docs/git-mod-catalog.md\` in the manager repository for the full format.
`;
}

function catalogIndex() {
  const mods = [
    {
      name: 'Example Mod',
      slug: 'example-mod',
      type: 'addon',
      version: '1.0.0',
      description: 'Root sample you can copy. Replace the empty archive with your pack.',
      author: 'Your Name',
      categories: ['addons'],
      file: 'example-mod/example-addon.mcaddon',
      thumbnail: 'example-mod/thumbnail.png',
    },
    ...CATEGORIES.map((item) => ({
      name: item.name,
      slug: item.slug,
      type: item.type,
      version: '1.0.0',
      description: item.description,
      author: 'Your Name',
      categories: item.categories,
      file: `${item.folder}/${item.slug}/${item.archive}`,
      thumbnail: `${item.folder}/${item.slug}/thumbnail.png`,
    })),
  ];
  return prettyJson({ version: 1, mods });
}

function exampleModJson({ name, slug, type, archive, categories, description }) {
  return prettyJson({
    name,
    slug,
    type,
    version: '1.0.0',
    description,
    author: 'Your Name',
    categories,
    file: archive,
  });
}

function buildStarterFiles() {
  const emptyArchive = zipStore({});
  const files = {
    [`${STARTER_ROOT}/README.md`]: starterReadme(),
    [`${STARTER_ROOT}/catalog.json`]: catalogIndex(),
    [`${STARTER_ROOT}/example-mod/mod.json`]: exampleModJson({
      name: 'Example Mod',
      slug: 'example-mod',
      type: 'addon',
      archive: 'example-addon.mcaddon',
      categories: ['addons'],
      description: 'Replace this sample with your pack files. file can be a string or an array of archives.',
    }),
    [`${STARTER_ROOT}/example-mod/thumbnail.png`]: SAMPLE_THUMBNAIL,
    [`${STARTER_ROOT}/example-mod/example-addon.mcaddon`]: emptyArchive,
  };

  for (const item of CATEGORIES) {
    const base = `${STARTER_ROOT}/${item.folder}/${item.slug}`;
    files[`${base}/mod.json`] = exampleModJson(item);
    files[`${base}/thumbnail.png`] = SAMPLE_THUMBNAIL;
    files[`${base}/${item.archive}`] = emptyArchive;
  }

  return files;
}

function buildStarterZip() {
  return zipStore(buildStarterFiles());
}

function starterFileNames() {
  return Object.keys(buildStarterFiles());
}

module.exports = {
  STARTER_FILENAME,
  STARTER_ROOT,
  buildStarterZip,
  starterFileNames,
};
