const ALLOW_EXACT = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'OS',
  'HOME',
  'USER',
  'USERNAME',
  'LOGNAME',
  'USERPROFILE',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'TERM',
  'DISPLAY',
]);

const DENY_RE = /^(MC_MANAGER_|GIT_|AWS_|SSH_|PG|MYSQL|DATABASE|DB_|SESSION|TOKEN|SECRET|PASSWORD|API_KEY|OPENAI_|GITHUB_|GITLAB_)/i;

function sanitizedChildEnv(extra = {}) {
  const out = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value == null) continue;
    if (DENY_RE.test(key)) continue;
    const upper = key.toUpperCase();
    if (ALLOW_EXACT.has(upper) || upper.startsWith('LC_')) {
      out[key] = value;
    }
  }
  for (const [key, value] of Object.entries(extra || {})) {
    if (value == null) continue;
    if (DENY_RE.test(key)) continue;
    out[key] = String(value);
  }
  return out;
}

function envContainsSecret(env, needle) {
  const text = JSON.stringify(env || {});
  return text.includes(String(needle));
}

module.exports = { envContainsSecret, sanitizedChildEnv };
