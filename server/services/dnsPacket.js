const TYPE_A = 1;
const TYPE_AAAA = 28;
const CLASS_IN = 1;

function decodeName(buf, offset) {
  const labels = [];
  let jumped = false;
  let end = offset;
  let hops = 0;

  while (hops++ < 20) {
    if (offset >= buf.length) throw new Error('truncated DNS name');
    const len = buf[offset];
    if (len === 0) {
      if (!jumped) end = offset + 1;
      return { name: labels.join('.'), end };
    }
    if ((len & 0xc0) === 0xc0) {
      if (offset + 1 >= buf.length) throw new Error('truncated DNS pointer');
      const ptr = ((len & 0x3f) << 8) | buf[offset + 1];
      if (!jumped) end = offset + 2;
      jumped = true;
      offset = ptr;
      continue;
    }
    if ((len & 0xc0) !== 0) throw new Error('invalid DNS label');
    offset += 1;
    if (offset + len > buf.length) throw new Error('truncated DNS label');
    labels.push(buf.slice(offset, offset + len).toString('ascii').toLowerCase());
    offset += len;
    if (!jumped) end = offset;
  }
  throw new Error('DNS name loop');
}

function parseQuery(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) throw new Error('short DNS packet');
  const id = buf.readUInt16BE(0);
  const flags = buf.readUInt16BE(2);
  const qdcount = buf.readUInt16BE(4);
  if (qdcount < 1) throw new Error('DNS packet has no question');
  const { name, end } = decodeName(buf, 12);
  if (end + 4 > buf.length) throw new Error('truncated DNS question');
  return {
    id,
    flags,
    name,
    type: buf.readUInt16BE(end),
    class: buf.readUInt16BE(end + 2),
    questionEnd: end + 4,
  };
}

function encodeAnswer({ type, ttl = 30, rdata }) {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(0xc00c, 0);
  head.writeUInt16BE(type, 2);
  head.writeUInt16BE(CLASS_IN, 4);
  head.writeUInt32BE(ttl, 6);
  head.writeUInt16BE(rdata.length, 10);
  return Buffer.concat([head, rdata]);
}

function ipv4Rdata(ip) {
  const parts = String(ip || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new Error(`invalid IPv4 address: ${ip}`);
  }
  return Buffer.from(parts);
}

function buildResponse(queryBuf, parsed, answers = [], rcode = 0) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(parsed.id, 0);
  const flags = 0x8000 | (parsed.flags & 0x0100) | 0x0080 | (rcode & 0xf);
  header.writeUInt16BE(flags, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answers.length, 6);
  const question = queryBuf.slice(12, parsed.questionEnd);
  const records = answers.map((answer) => encodeAnswer(answer));
  return Buffer.concat([header, question, ...records]);
}

function buildAResponse(queryBuf, parsed, ipv4, ttl = 30) {
  return buildResponse(queryBuf, parsed, [{
    type: TYPE_A,
    ttl,
    rdata: ipv4Rdata(ipv4),
  }]);
}

function buildEmptyResponse(queryBuf, parsed, rcode = 0) {
  return buildResponse(queryBuf, parsed, [], rcode);
}

function buildServFail(queryBuf, parsed) {
  return buildEmptyResponse(queryBuf, parsed, 2);
}

module.exports = {
  TYPE_A,
  TYPE_AAAA,
  CLASS_IN,
  parseQuery,
  buildAResponse,
  buildEmptyResponse,
  buildServFail,
  ipv4Rdata,
};
