/**
 * Host-level DNS redirection coordinator.
 * The manager does not currently mutate OS resolver or hosts-file state.
 * Disable/enable still call this so a future implementation has a single revert point.
 */

function status() {
  return { active: false, changed: false };
}

async function revert() {
  const current = status();
  return {
    ok: true,
    changed: false,
    active: false,
    detail: current.active
      ? 'Host-level DNS redirection was reverted'
      : 'No host-level DNS redirection is active',
  };
}

module.exports = {
  revert,
  status,
};
