const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC_RE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const ANSI_CHAR_RE = /\u001b[@-Z\\-_]/g;
const CSI_8BIT_RE = /\u009b[\d;]*[A-Za-z]/g;
const BARE_SGR_RE = /\[(?:\d{1,3}(?:;\d{1,3})*)?m/g;
const LIST_HEADER_RE = /There are\s+(\d+)\s*\/\s*(\d+)\s+players online:?/i;
const LIST_NONE_RE = /No players currently online/i;
const JOIN_RE = /Player (?:connected|spawned):\s*([^\r\n]+)/gi;
const LEAVE_RE = /Player disconnected:\s*([^\r\n]+)/gi;

function stripAnsi(text) {
  return String(text || '')
    .replace(ANSI_OSC_RE, '')
    .replace(ANSI_RE, '')
    .replace(ANSI_CHAR_RE, '')
    .replace(CSI_8BIT_RE, '')
    .replace(BARE_SGR_RE, '')
    .replace(/\r/g, '');
}

function normalizeUsername(value) {
  return String(value || '')
    .replace(/\s+xuid:.*$/i, '')
    .replace(/\s+pfid:.*$/i, '')
    .trim();
}

function extractXuid(value) {
  const match = String(value || '').match(/xuid:\s*(\d+)/i);
  return match ? match[1] : null;
}

function hasListResult(text) {
  const cleaned = stripAnsi(text);
  return LIST_HEADER_RE.test(cleaned) || LIST_NONE_RE.test(cleaned);
}

function parseListOutput(text) {
  const cleaned = stripAnsi(text);
  if (LIST_NONE_RE.test(cleaned)) return [];

  const header = cleaned.match(LIST_HEADER_RE);
  if (!header) return [];

  const count = Number(header[1]);
  if (!count) return [];

  const after = cleaned.slice(header.index + header[0].length);
  const names = [];
  const seen = new Set();

  for (const line of after.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (names.length) break;
      continue;
    }
    if (/^\[/.test(trimmed) && /INFO|WARN|ERROR/i.test(trimmed)) break;
    if (/^(list|\/list|Unknown command|NO COMMAND|There are)\b/i.test(trimmed)) continue;

    for (const part of trimmed.split(',')) {
      const name = normalizeUsername(part);
      const key = name.toLowerCase();
      if (!name || seen.has(key) || /^\d+\s*\/\s*\d+$/.test(name)) continue;
      seen.add(key);
      names.push(name);
    }
    if (names.length >= count) break;
  }

  return names;
}

function parsePresenceEvents(text) {
  const cleaned = stripAnsi(text);
  const events = [];
  let match;

  JOIN_RE.lastIndex = 0;
  while ((match = JOIN_RE.exec(cleaned)) !== null) {
    const username = normalizeUsername(match[1].split(',')[0]);
    if (!username) continue;
    events.push({
      type: 'join',
      username,
      xuid: extractXuid(match[1]),
    });
  }

  LEAVE_RE.lastIndex = 0;
  while ((match = LEAVE_RE.exec(cleaned)) !== null) {
    const username = normalizeUsername(match[1].split(',')[0]);
    if (!username) continue;
    events.push({ type: 'leave', username, xuid: extractXuid(match[1]) });
  }

  return events;
}

function inferOnlineFromBuffer(text) {
  const online = new Map();
  for (const event of parsePresenceEvents(text)) {
    const key = event.username.toLowerCase();
    if (event.type === 'join') online.set(key, event);
    else online.delete(key);
  }
  return [...online.values()];
}

module.exports = {
  stripAnsi,
  normalizeUsername,
  hasListResult,
  parseListOutput,
  parsePresenceEvents,
  inferOnlineFromBuffer,
};
