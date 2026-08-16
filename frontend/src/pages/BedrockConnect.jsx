import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle, Check, ExternalLink, Globe, Loader2, Plus, Save, Trash2
} from 'lucide-react';
import { bedrockConnectApi } from '../services/api';

const PLATFORMS = [
  { id: 'switch', label: 'Switch' },
  { id: 'switch2', label: 'Switch 2' },
  { id: 'playstation', label: 'PlayStation' },
  { id: 'xbox', label: 'Xbox' },
  { id: 'pc', label: 'PC' },
];

function InstructionList({ items }) {
  return (
    <ol className="list-decimal pl-5 space-y-2 text-sm text-mc-text">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ol>
  );
}

function DnsInstructions({ listenIp }) {
  const [platform, setPlatform] = useState('switch');
  const primary = listenIp || 'this host\'s LAN IPv4';

  const sharedClose = [
    `Set the primary DNS to ${primary} and leave the secondary DNS empty.`,
    'Save, reconnect to the network if the console asks you to, then open Minecraft.',
    'Open the Servers tab and join a redirect-compatible featured server (Mineville, Lifeboat, Enchanted, Galaxite, or The Hive) to open Bedrock Connect.',
  ];

  const content = {
    switch: (
      <>
        <p className="text-sm text-mc-textMuted mb-3">
          Nintendo Switch cannot add a custom Bedrock address. Point its DNS at this manager, then join a featured server that Bedrock Connect can redirect.
        </p>
        <InstructionList items={[
          'Open System Settings → Internet → Internet Settings.',
          'Select your current network, then Change Settings.',
          'Set DNS Settings to Manual.',
          ...sharedClose,
        ]} />
      </>
    ),
    switch2: (
      <>
        <p className="text-sm text-mc-textMuted mb-3">
          Switch 2 uses the same DNS method as Switch. The console still cannot type a custom Bedrock IP, so featured-server redirects are required.
        </p>
        <InstructionList items={[
          'Open System Settings → Internet → Internet Settings.',
          'Select your current network, then Change Settings.',
          'Set DNS Settings to Manual.',
          ...sharedClose,
        ]} />
      </>
    ),
    playstation: (
      <>
        <p className="text-sm text-mc-textMuted mb-3">
          PlayStation 4 and PlayStation 5 both use a manual DNS setting. If this host is on the same LAN, Worlds/LAN can also find Bedrock Connect on UDP 19132, but DNS still helps for featured-server redirects.
        </p>
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-white mb-2">PS5</h3>
            <InstructionList items={[
              'From the home screen open Settings → Network → Settings → Set Up Internet Connection.',
              'Open Advanced Settings and set DNS Settings to Manual.',
              ...sharedClose,
            ]} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white mb-2">PS4</h3>
            <InstructionList items={[
              'From the home screen open Settings → Network → Set Up Internet Connection.',
              'Choose your connection type, then Custom.',
              'Use Automatic for IP address settings and Do Not Specify for DHCP host name.',
              'On DNS Settings choose Manual.',
              `Enter ${primary} as the primary DNS and leave the secondary DNS empty.`,
              'Use Automatic for MTU, Do Not Use for proxy, then test the connection.',
              'Open Minecraft, go to Servers, and join a redirect-compatible featured server.',
            ]} />
          </div>
        </div>
      </>
    ),
    xbox: (
      <>
        <p className="text-sm text-mc-textMuted mb-3">
          Xbox cannot add a custom Bedrock IP:port. DNS redirection is the reliable way to reach this host's Bedrock Connect list from the Servers tab.
        </p>
        <InstructionList items={[
          'Open Settings → General → Network settings.',
          'Choose Advanced settings → DNS settings.',
          'Select Manual.',
          ...sharedClose,
        ]} />
      </>
    ),
    pc: (
      <>
        <p className="text-sm text-mc-textMuted mb-3">
          Windows, iOS, Android, and Java-free Bedrock on PC can add servers by IP, so DNS is optional. Use it when you want featured-server names or other hostnames to resolve to this LAN.
        </p>
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-white mb-2">Windows 10 / 11</h3>
            <InstructionList items={[
              'Open Settings → Network & internet and select Wi-Fi or Ethernet.',
              'Open the active connection, then DNS server assignment → Edit.',
              'Choose Manual, enable IPv4, and set the preferred DNS to this host.',
              `Preferred DNS: ${primary}. Leave the alternate DNS empty.`,
              'Save, then either add this host as a Bedrock server or join a featured server if you are using overrides.',
            ]} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white mb-2">Direct connect without DNS</h3>
            <p className="text-sm text-mc-text">
              On PC you can skip DNS and add <span className="font-mono text-mc-accent">{primary}:19132</span> as a server. Consoles cannot do that, which is why this DNS proxy exists.
            </p>
          </div>
        </div>
      </>
    ),
  };

  return (
    <div className="card">
      <h2 className="text-lg font-semibold text-white mb-1">Console DNS setup</h2>
      <p className="text-sm text-mc-textMuted mb-4">
        Point each console at this manager's IPv4 as its only DNS server. Leave the secondary DNS empty so the device does not fall back to another resolver.
      </p>
      <div className="flex flex-wrap gap-2 mb-4">
        {PLATFORMS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setPlatform(item.id)}
            className={`btn text-sm ${platform === item.id ? 'btn-primary' : 'btn-secondary'}`}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="rounded-lg border border-mc-surfaceLight bg-mc-darker p-4">
        <p className="text-xs text-mc-textMuted mb-3">
          Primary DNS: <span className="font-mono text-mc-accent">{primary}</span>
          {' · '}
          Secondary DNS: leave empty
        </p>
        {content[platform]}
      </div>
    </div>
  );
}

function BedrockConnectPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [installed, setInstalled] = useState(false);
  const [bc, setBc] = useState(null);
  const [dns, setDns] = useState(null);
  const [enabled, setEnabled] = useState(false);
  const [upstreams, setUpstreams] = useState(['', '', '']);
  const [overrides, setOverrides] = useState([]);
  const [newHost, setNewHost] = useState('');
  const [newIpv4, setNewIpv4] = useState('');

  const applyPayload = (data) => {
    setInstalled(Boolean(data.installed));
    setBc(data.bedrockConnect || null);
    setDns(data.dns || null);
    setEnabled(Boolean(data.dns?.enabled));
    const nextUpstreams = [...(data.dns?.upstreams || [])];
    while (nextUpstreams.length < 3) nextUpstreams.push('');
    setUpstreams(nextUpstreams.slice(0, 3));
    setOverrides(data.dns?.overrides || []);
    setNewIpv4((current) => current || data.dns?.listenIp || '');
  };

  const load = async () => {
    try {
      const res = await bedrockConnectApi.get();
      applyPayload(res.data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load Bedrock Connect settings');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleSave = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const res = await bedrockConnectApi.saveDns({
        enabled,
        upstreams,
        overrides,
      });
      applyPayload(res.data);
      setSuccess('DNS settings saved');
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to save DNS settings');
    } finally {
      setSaving(false);
    }
  };

  const addOverride = (hostname, ipv4) => {
    const host = String(hostname || '').trim();
    const ip = String(ipv4 || '').trim() || dns?.listenIp || '';
    if (!host || !ip) {
      setError('Enter a hostname and IPv4 address for the override');
      return;
    }
    if (overrides.length >= (dns?.maxOverrides || 20)) {
      setError(`At most ${dns?.maxOverrides || 20} DNS overrides can be stored`);
      return;
    }
    if (overrides.some((row) => row.hostname.toLowerCase() === host.toLowerCase())) {
      setError(`${host} is already in the override list`);
      return;
    }
    setError('');
    setOverrides((prev) => [...prev, { hostname: host, ipv4: ip }]);
    setNewHost('');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-mc-accent animate-spin" />
          <p className="text-sm text-mc-textMuted">Loading Bedrock Connect...</p>
        </div>
      </div>
    );
  }

  if (!installed) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="flex items-center gap-4 mb-8">
          <div className="w-12 h-12 rounded-xl bg-mc-accent/10 flex items-center justify-center">
            <Globe className="w-6 h-6 text-mc-accent" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">BedrockConnect</h1>
            <p className="text-mc-textMuted mt-1">Console DNS and featured-server redirects</p>
          </div>
        </div>
        <div className="card text-center">
          <p className="text-lg text-white mb-4">Create a bedrockConnect server to use these features</p>
          <button type="button" onClick={() => navigate('/')} className="btn btn-primary">
            Go to Dashboard
          </button>
        </div>
      </div>
    );
  }

  const maxOverrides = dns?.maxOverrides || 20;
  const status = dns?.status || {};

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4 mb-8">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-mc-accent/10 flex items-center justify-center">
            <Globe className="w-6 h-6 text-mc-accent" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">BedrockConnect</h1>
            <p className="text-mc-textMuted mt-1">
              {bc?.name || 'Bedrock Connect'} is installed
              {bc?.status ? ` · ${bc.status}` : ''}
            </p>
          </div>
        </div>
        <a
          href="https://github.com/Pugmatt/BedrockConnect"
          target="_blank"
          rel="noreferrer"
          className="btn btn-secondary text-sm"
        >
          <ExternalLink className="w-4 h-4" />
          Bedrock Connect on GitHub
        </a>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}
      {success && (
        <div className="mb-4 p-3 bg-green-500/10 border border-green-500/30 rounded-lg flex items-center gap-2">
          <Check className="w-4 h-4 text-green-400 flex-shrink-0" />
          <p className="text-sm text-green-400">{success}</p>
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-6">
        <div className="card">
          <h2 className="text-lg font-semibold text-white">Local DNS proxy</h2>
          <p className="text-sm text-mc-textMuted mt-1 mb-4">
            Accept DNS on this host, answer overrides locally, and forward everything else upstream. Keep UDP/TCP 53 on the LAN only; this proxy is a recursive resolver for anyone who can reach it.
          </p>
          <div className="mb-4 p-3 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-200 text-sm font-bold leading-relaxed">
            If you use this server as a DNS proxy, it MUST remain online for your systems to connect to the internet properly, or you must revert those systems back to their automatic DNS settings. If you fail to do this, your systems WILL NOT connect to the internet if this server is taken offline.
          </div>
          <div className="flex items-center justify-between p-3 bg-mc-darker rounded-lg mb-4">
            <div>
              <p className="text-sm font-medium text-white">Enable DNS proxy</p>
              <p className="text-xs text-mc-textMuted">Answer overrides on this host and forward everything else upstream</p>
            </div>
            <button
              type="button"
              onClick={() => setEnabled(value => !value)}
              className={`toggle ${enabled ? 'toggle-active' : 'toggle-inactive'}`}
              aria-pressed={enabled}
            >
              <span className={`toggle-thumb ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
            <div className="rounded-lg bg-mc-darker p-3">
              <p className="text-xs text-mc-textMuted">Listen IPv4</p>
              <p className="font-mono text-white mt-1">{dns?.listenIp || 'Not detected'}</p>
            </div>
            <div className="rounded-lg bg-mc-darker p-3">
              <p className="text-xs text-mc-textMuted">Status</p>
              <p className={`mt-1 ${status.running ? 'text-green-400' : 'text-mc-textMuted'}`}>
                {status.running ? `Listening on ${status.address}:${status.port}` : 'Stopped'}
              </p>
            </div>
            <div className="rounded-lg bg-mc-darker p-3">
              <p className="text-xs text-mc-textMuted">Host resolvers</p>
              <p className="font-mono text-white mt-1 break-all">
                {(dns?.hostNameservers || []).join(', ') || 'None detected'}
              </p>
            </div>
          </div>
          {status.error && (
            <p className="text-sm text-amber-400 mt-3">{status.error}</p>
          )}
        </div>

        <div className="card">
          <h2 className="text-lg font-semibold text-white mb-1">Upstream DNS</h2>
          <p className="text-sm text-mc-textMuted mb-4">
            Leave these blank to use whatever DNS this host already uses. You can add up to three IPv4 resolvers if you want to choose your own.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {upstreams.map((value, index) => (
              <div key={index}>
                <label className="block text-sm font-medium text-mc-text mb-2">
                  Upstream {index + 1}
                </label>
                <input
                  type="text"
                  value={value}
                  onChange={(e) => {
                    const next = [...upstreams];
                    next[index] = e.target.value;
                    setUpstreams(next);
                  }}
                  className="input"
                  placeholder={index === 0 ? 'Host default' : 'Optional'}
                />
              </div>
            ))}
          </div>
        </div>

        <DnsInstructions listenIp={dns?.listenIp} />

        <div className="card">
          <h2 className="text-lg font-semibold text-white mb-1">Known featured servers</h2>
          <p className="text-sm text-mc-textMuted mb-4">
            {dns?.knownServersNote}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-mc-textMuted border-b border-mc-surfaceLight">
                  <th className="py-2 pr-3 font-medium">Server</th>
                  <th className="py-2 pr-3 font-medium">Hostname</th>
                  <th className="py-2 pr-3 font-medium">Documented public target</th>
                  <th className="py-2 pr-3 font-medium">Notes</th>
                  <th className="py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {(dns?.knownServers || []).map((server) => (
                  <tr key={server.hostname} className="border-b border-mc-surfaceLight/60">
                    <td className="py-2 pr-3 text-white">{server.name}</td>
                    <td className="py-2 pr-3 font-mono text-mc-accent">{server.hostname}</td>
                    <td className="py-2 pr-3 font-mono text-mc-text">{server.examplePublicIp}</td>
                    <td className="py-2 pr-3 text-mc-textMuted">{server.notes}</td>
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        className="btn btn-secondary text-xs"
                        onClick={() => addOverride(server.hostname, dns?.listenIp)}
                      >
                        Override to this host
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-lg font-semibold text-white">DNS overrides</h2>
            <p className="text-xs text-mc-textMuted">{overrides.length}/{maxOverrides}</p>
          </div>
          <p className="text-sm text-mc-textMuted mb-4">
            These names answer with the IPv4 you enter instead of the public address. Use this host's LAN IP to send featured-server joins to Bedrock Connect, or another local address if you want that name to hit a different resource.
          </p>
          <div className="space-y-2 mb-4">
            {overrides.length === 0 && (
              <p className="text-sm text-mc-textMuted">No overrides yet.</p>
            )}
            {overrides.map((row, index) => (
              <div key={`${row.hostname}-${index}`} className="grid grid-cols-1 md:grid-cols-[1fr_180px_auto] gap-2">
                <input
                  type="text"
                  value={row.hostname}
                  onChange={(e) => {
                    const next = [...overrides];
                    next[index] = { ...next[index], hostname: e.target.value };
                    setOverrides(next);
                  }}
                  className="input"
                  placeholder="play.example.net"
                />
                <input
                  type="text"
                  value={row.ipv4}
                  onChange={(e) => {
                    const next = [...overrides];
                    next[index] = { ...next[index], ipv4: e.target.value };
                    setOverrides(next);
                  }}
                  className="input"
                  placeholder="10.0.1.142"
                />
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setOverrides(overrides.filter((_, i) => i !== index))}
                  title="Remove override"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-[1fr_180px_auto] gap-2">
            <input
              type="text"
              value={newHost}
              onChange={(e) => setNewHost(e.target.value)}
              className="input"
              placeholder="Hostname to override"
              disabled={overrides.length >= maxOverrides}
            />
            <input
              type="text"
              value={newIpv4}
              onChange={(e) => setNewIpv4(e.target.value)}
              className="input"
              placeholder="IPv4"
              disabled={overrides.length >= maxOverrides}
            />
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => addOverride(newHost, newIpv4)}
              disabled={overrides.length >= maxOverrides}
            >
              <Plus className="w-4 h-4" />
              Add
            </button>
          </div>
        </div>

        <div className="flex justify-end">
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {saving ? 'Saving...' : 'Save DNS settings'}
          </button>
        </div>
      </form>
    </div>
  );
}

export default BedrockConnectPage;
