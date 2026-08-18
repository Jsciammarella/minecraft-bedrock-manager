const IPV6_OFFSET = 1000;
const DISCOVERY_IPV4 = 19132;
const DISCOVERY_IPV6 = 19133;

const IPV4_GAME_RANGES = [
  [19132, 19199],
  [25565, 25665],
  [30000, 30100],
];

const IPV6_GAME_RANGES = IPV4_GAME_RANGES.map(([start, end]) => [start - IPV6_OFFSET, end - IPV6_OFFSET]);

function inRanges(port, ranges) {
  const value = Number(port);
  return ranges.some(([start, end]) => value >= start && value <= end);
}

function expandRanges(ranges) {
  const ports = [];
  for (const [start, end] of ranges) {
    for (let port = start; port <= end; port += 1) ports.push(port);
  }
  return ports;
}

function isIpv4GamePort(port) {
  return inRanges(port, IPV4_GAME_RANGES) && Number(port) !== DISCOVERY_IPV6;
}

function isIpv6GamePort(port) {
  return inRanges(port, IPV6_GAME_RANGES);
}

function isDiscoveryPort(port) {
  const value = Number(port);
  return value === DISCOVERY_IPV4 || value === DISCOVERY_IPV6;
}

function preferredIpv6Port(ipv4Port) {
  const preferred = Number(ipv4Port) - IPV6_OFFSET;
  return isIpv6GamePort(preferred) ? preferred : null;
}

function classifyFamily(port) {
  const value = Number(port);
  if (value === DISCOVERY_IPV6 || isIpv6GamePort(value)) return 'ipv6';
  return 'ipv4';
}

function ipv4Candidates() {
  return expandRanges(IPV4_GAME_RANGES).filter((port) => port !== DISCOVERY_IPV6);
}

function ipv6Candidates() {
  return expandRanges(IPV6_GAME_RANGES);
}

module.exports = {
  DISCOVERY_IPV4,
  DISCOVERY_IPV6,
  IPV4_GAME_RANGES,
  IPV6_GAME_RANGES,
  IPV6_OFFSET,
  classifyFamily,
  ipv4Candidates,
  ipv6Candidates,
  isDiscoveryPort,
  isIpv4GamePort,
  isIpv6GamePort,
  preferredIpv6Port,
};
