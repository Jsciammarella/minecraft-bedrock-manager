const ID_RE = /^[a-z][a-z0-9-]{0,62}$/;
const FIELD_ID_RE = /^[a-z][a-zA-Z0-9-]{0,62}$/;
const FIELD_TYPES = new Set([
  'toggle',
  'text',
  'secret',
  'secret-status',
  'help',
  'link',
  'notice',
  'group',
  'sync-status',
  'status',
  'button',
]);
const ACTION_VARIANTS = new Set(['primary', 'secondary', 'danger']);
const BUTTON_ICONS = new Set([
  'save', 'refresh', 'check', 'download', 'folder', 'eye', 'alert',
]);
const VALIDATION_RULES = new Set([
  'required', 'url', 'git-url', 'branch', 'subdir', 'path', 'username',
]);
const LAYOUTS = new Set(['stack', 'grid-2']);
const LINK_HOSTS = new Set([
  'console.curseforge.com',
  'curseforge.com',
  'www.curseforge.com',
  'github.com',
  'www.github.com',
  'docs.github.com',
  'gitlab.com',
  'www.gitlab.com',
  'git-scm.com',
  'modrinth.com',
  'www.modrinth.com',
  'docs.modrinth.com',
]);
const SECRET_STORAGE_KEYS = new Set([
  'curseforge_api_key',
  'git_catalog_token',
  'file_catalog_smb_password',
]);
const SECRET_OWNERS = {
  curseforge_api_key: 'catalog-curseforge',
  git_catalog_token: 'catalog-git',
  file_catalog_smb_password: 'catalog-file',
};

const UNSAFE_TEXT = /[<>]|javascript:|data:|vbscript:|on\w+\s*=/i;

function fail(message) {
  const err = Object.assign(new Error(message), { status: 400, code: 'INVALID_SETTINGS_DESCRIPTOR' });
  throw err;
}

function plainText(value, max = 400, label = 'text') {
  if (value == null) return '';
  if (typeof value !== 'string') fail(`${label} must be plain text`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (UNSAFE_TEXT.test(text)) fail(`${label} cannot include HTML, scripts, or event handlers`);
  if (text.length > max) fail(`${label} is too long`);
  return text;
}

function slug(value, label = 'id') {
  const id = String(value || '').trim();
  const pattern = /field|secret/i.test(label) ? FIELD_ID_RE : ID_RE;
  if (!pattern.test(id)) fail(`${label} must be a lowercase slug`);
  return id;
}

function safeLink(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw || ''));
  } catch {
    fail('documentation links must be absolute https URLs');
  }
  if (parsed.protocol !== 'https:') fail('documentation links must use https');
  if (parsed.username || parsed.password) fail('documentation links cannot include credentials');
  const host = parsed.hostname.toLowerCase();
  if (!LINK_HOSTS.has(host)) fail('documentation link host is not allowlisted');
  return parsed.toString();
}

function parseDependsOn(raw) {
  if (raw == null) return null;
  const row = typeof raw === 'string' ? { field: raw, value: true } : raw;
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail('dependsOn must be an object');
  return {
    field: slug(row.field, 'dependsOn.field'),
    value: row.value === undefined ? true : row.value,
  };
}

function parseAction(raw, seen) {
  const id = slug(raw && raw.id, 'action id');
  if (seen.has(id)) fail(`duplicate action "${id}"`);
  seen.add(id);
  const variant = String((raw && raw.variant) || 'secondary').trim().toLowerCase();
  if (!ACTION_VARIANTS.has(variant)) fail(`unknown action variant "${variant}"`);
  const icon = String((raw && raw.icon) || '').trim().toLowerCase();
  if (icon && !BUTTON_ICONS.has(icon)) fail(`unknown action icon "${icon}"`);
  return {
    id,
    label: plainText(raw.label || id, 80, 'action label') || id,
    variant,
    icon: icon || '',
    download: Boolean(raw && raw.download),
    filename: plainText(raw && raw.filename, 120, 'filename'),
    help: plainText(raw && raw.help, 240, 'action help'),
    dependsOn: parseDependsOn(raw && raw.dependsOn),
  };
}

function parseField(raw, seen, pluginId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('fields must be objects');
  const id = slug(raw.id, 'field id');
  if (seen.has(id)) fail(`duplicate field "${id}"`);
  seen.add(id);
  const type = String(raw.type || '').trim().toLowerCase();
  if (!FIELD_TYPES.has(type)) fail(`unknown field type "${type}"`);
  const field = {
    id,
    type,
    label: plainText(raw.label, 120, 'field label'),
    help: plainText(raw.help, 400, 'help text'),
    placeholder: plainText(raw.placeholder, 200, 'placeholder'),
    span: Number(raw.span) === 2 ? 2 : 1,
    dependsOn: parseDependsOn(raw.dependsOn),
  };
  if (raw.validation != null) {
    const rules = Array.isArray(raw.validation) ? raw.validation : [raw.validation];
    field.validation = rules.map((rule) => {
      const name = String(rule || '').trim().toLowerCase();
      if (!VALIDATION_RULES.has(name)) fail(`unknown validation rule "${name}"`);
      return name;
    });
  }
  if (type === 'link') {
    field.href = safeLink(raw.href);
    field.label = field.label || 'Open documentation';
  }
  if (type === 'secret' || type === 'secret-status') {
    const storageKey = String(raw.storageKey || '').trim();
    if (!SECRET_STORAGE_KEYS.has(storageKey)) fail('secret fields must use a core storage key');
    if (SECRET_OWNERS[storageKey] !== pluginId) fail('plugin does not own that secret storage key');
    field.storageKey = storageKey;
    field.secretId = slug(raw.secretId || id, 'secret id');
    field.clearLabel = plainText(raw.clearLabel, 80, 'clearLabel');
    field.replaceLabel = plainText(raw.replaceLabel, 80, 'replaceLabel');
  }
  if (type === 'button') {
    field.actionId = slug(raw.actionId, 'button actionId');
    const variant = String(raw.variant || 'secondary').trim().toLowerCase();
    if (!ACTION_VARIANTS.has(variant)) fail(`unknown button variant "${variant}"`);
    field.variant = variant;
    field.icon = String(raw.icon || '').trim().toLowerCase();
    if (field.icon && !BUTTON_ICONS.has(field.icon)) fail(`unknown button icon "${field.icon}"`);
  }
  if (type === 'sync-status') {
    field.statusKey = plainText(raw.statusKey || 'sync', 40, 'statusKey') || 'sync';
  }
  if (type === 'status') {
    field.statusKey = plainText(raw.statusKey || id, 40, 'statusKey') || id;
  }
  if (type === 'group') {
    const nestedSeen = new Set();
    field.title = plainText(raw.title, 80, 'group title');
    field.description = plainText(raw.description, 400, 'group description');
    field.fields = Array.isArray(raw.fields)
      ? raw.fields.map((item) => parseField(item, nestedSeen, pluginId))
      : [];
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'html')
    || Object.prototype.hasOwnProperty.call(raw, 'jsx')
    || Object.prototype.hasOwnProperty.call(raw, 'css')
    || Object.prototype.hasOwnProperty.call(raw, 'script')
    || Object.prototype.hasOwnProperty.call(raw, 'onClick')
    || Object.prototype.hasOwnProperty.call(raw, 'handler')
    || Object.prototype.hasOwnProperty.call(raw, 'regex')
    || Object.prototype.hasOwnProperty.call(raw, 'command')
    || Object.prototype.hasOwnProperty.call(raw, 'endpoint')) {
    fail('settings descriptors cannot include executable UI, commands, or unrestricted patterns');
  }
  return field;
}

function parseSection(raw, seenFields, seenActions, pluginId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('sections must be objects');
  const layout = String(raw.layout || 'stack').trim().toLowerCase();
  if (!LAYOUTS.has(layout)) fail(`unknown section layout "${layout}"`);
  const actions = Array.isArray(raw.actions)
    ? raw.actions.map((item) => parseAction(item, seenActions))
    : [];
  return {
    id: slug(raw.id, 'section id'),
    title: plainText(raw.title, 80, 'section title'),
    description: plainText(raw.description, 800, 'section description'),
    layout,
    fields: Array.isArray(raw.fields) ? raw.fields.map((item) => parseField(item, seenFields, pluginId)) : [],
    actions,
  };
}

function validateDescriptor(raw, pluginId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('settings descriptor must be an object');
  if (raw.html || raw.jsx || raw.css || raw.script || typeof raw.render === 'function') {
    fail('settings descriptors cannot include HTML, JSX, CSS, or JavaScript');
  }
  const seenFields = new Set();
  const seenActions = new Set();
  const sections = Array.isArray(raw.sections)
    ? raw.sections.map((section) => parseSection(section, seenFields, seenActions, pluginId))
    : [];
  if (!sections.length) fail('settings descriptor requires at least one section');
  const footerActions = Array.isArray(raw.footerActions)
    ? raw.footerActions.map((item) => parseAction(item, seenActions))
    : [];
  return {
    title: plainText(raw.title, 80, 'title'),
    description: plainText(raw.description, 400, 'description'),
    sections,
    footerActions,
  };
}

function collectFields(descriptor) {
  const fields = [];
  const walk = (list) => {
    for (const field of list || []) {
      fields.push(field);
      if (field.type === 'group') walk(field.fields);
    }
  };
  for (const section of descriptor.sections || []) walk(section.fields);
  return fields;
}

module.exports = {
  BUTTON_ICONS,
  FIELD_TYPES,
  LINK_HOSTS,
  SECRET_OWNERS,
  SECRET_STORAGE_KEYS,
  collectFields,
  plainText,
  validateDescriptor,
};
