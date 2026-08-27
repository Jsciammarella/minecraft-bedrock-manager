export function serverCapability(server, key, fallback = false) {
  if (server?.capabilities?.authorizationScoped) {
    return Boolean(server.capabilities[key]);
  }
  return Boolean(fallback);
}
