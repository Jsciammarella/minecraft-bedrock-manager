import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { serverApi, portApi } from '../services/api';
import { useApi } from '../context/ApiContext';
import { ArrowLeft, Server, Loader2, Check, AlertCircle } from 'lucide-react';

const MAX_REMOTE_SERVERS = 10;
const LAN_DISCOVERY_PORTS = new Set([19132, 19133]);

function CreateServer() {
  const navigate = useNavigate();
  const { refresh, servers } = useApi();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [remote, setRemote] = useState(false);
  const [java, setJava] = useState(false);
  const [acceptEula, setAcceptEula] = useState(false);
  const [javaVersions, setJavaVersions] = useState(['latest']);
  
  const [formData, setFormData] = useState({
    name: '',
    port: '',
    ipv6Port: '',
    version: 'latest',
    maxPlayers: '10',
    description: '',
    gamemode: 'survival',
    difficulty: 'peaceful',
    remoteHost: '',
    remoteIpv4Port: '19132',
    remoteIpv6Port: '19133',
  });

  const [ports, setPorts] = useState({ used: [], available: [] });

  useEffect(() => {
    loadPorts();
    serverApi.javaVersions()
      .then((res) => {
        const ids = res.data?.versions || [];
        setJavaVersions(['latest', ...ids.filter((id) => id && id !== 'latest')]);
      })
      .catch(() => setJavaVersions(['latest']));
  }, []);

  const ipv4Available = (ports.available || []).filter((item) => item.family !== 'ipv6');
  const ipv6Available = (ports.available || []).filter((item) => item.family === 'ipv6');
  const ipv4Choices = ipv4Available.filter((item) => !remote || !LAN_DISCOVERY_PORTS.has(item.port));
  const ipv6Choices = ipv6Available.filter((item) => !remote || !LAN_DISCOVERY_PORTS.has(item.port));
  const remoteCount = (servers || []).filter((server) => server.kind === 'remote').length;

  const loadPorts = async () => {
    try {
      const res = await portApi.getAll();
      setPorts(res.data);
      const v4List = (res.data.available || []).filter((item) => item.family !== 'ipv6');
      const v6List = (res.data.available || []).filter((item) => item.family === 'ipv6');
      const defaultV4 = v4List[0]?.port;
      if (defaultV4) {
        const preferredV6 = defaultV4 - 1000;
        const defaultV6 = v6List.find((item) => item.port === preferredV6)?.port || v6List[0]?.port;
        setFormData((prev) => ({
          ...prev,
          port: prev.port || String(defaultV4),
          ipv6Port: prev.ipv6Port || (defaultV6 != null ? String(defaultV6) : ''),
        }));
      }
    } catch (err) {
      console.error('Failed to load ports:', err);
    }
  };

  const firstIpv4 = ipv4Choices[0]?.port;
  const pairedIpv6 = (ipv4Port) => {
    const preferred = Number(ipv4Port) - 1000;
    return ipv6Choices.find((item) => item.port === preferred)?.port || ipv6Choices[0]?.port;
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => {
      const next = { ...prev, [name]: value };
      if (name === 'port') {
        const v4 = value === '' ? firstIpv4 : parseInt(value, 10);
        if (v4) {
          next.port = String(v4);
          const match = pairedIpv6(v4);
          if (match) next.ipv6Port = String(match);
        }
      }
      if (name === 'ipv6Port' && value === '') {
        const match = pairedIpv6(prev.port) || ipv6Choices[0]?.port;
        if (match) next.ipv6Port = String(match);
      }
      return next;
    });
    setError('');
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setSuccess('');

    try {
      const payload = remote
        ? {
            kind: 'remote',
            name: formData.name,
            port: parseInt(formData.port, 10),
            ipv6Port: formData.ipv6Port === '' ? undefined : parseInt(formData.ipv6Port, 10),
            remoteHost: formData.remoteHost,
            remoteIpv4Port: parseInt(formData.remoteIpv4Port, 10),
            remoteIpv6Port: formData.remoteIpv6Port === '' ? undefined : parseInt(formData.remoteIpv6Port, 10),
          }
        : java
          ? {
              kind: 'java',
              name: formData.name,
              port: parseInt(formData.port, 10),
              version: formData.version,
              maxPlayers: parseInt(formData.maxPlayers, 10),
              description: formData.description,
              gamemode: formData.gamemode,
              difficulty: formData.difficulty,
              acceptEula,
            }
          : {
            ...formData,
            port: parseInt(formData.port, 10),
            ipv6Port: formData.ipv6Port === '' ? undefined : parseInt(formData.ipv6Port, 10),
            maxPlayers: parseInt(formData.maxPlayers, 10),
          };
      if (java && !remote && !acceptEula) {
        setError('You must agree to the Minecraft EULA to create a Java Edition server');
        setLoading(false);
        return;
      }
      await serverApi.create(payload);
      await refresh();
      navigate('/');
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to create server');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-4 md:p-6 max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-4 mb-8">
        <button
          onClick={() => navigate(-1)}
          className="p-2 hover:bg-mc-surfaceLight rounded-lg transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-2xl font-bold text-white">Create New Server</h1>
          <p className="text-mc-textMuted mt-1">
            {remote
              ? 'Forward a local UDP port to a pingable Minecraft Bedrock host'
              : java
                ? 'Set up a new Minecraft Java Edition server'
                : 'Set up a new Minecraft Bedrock server'}
          </p>
        </div>
      </div>

      {/* Messages */}
      {error && (
        <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center gap-3 animate-slide-up">
          <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}
      {success && (
        <div className="mb-6 p-4 bg-green-500/10 border border-green-500/30 rounded-lg flex items-center gap-3 animate-slide-up">
          <Check className="w-5 h-5 text-green-400 flex-shrink-0" />
          <p className="text-sm text-green-400">{success}</p>
        </div>
      )}

      {/* Form */}
      <form onSubmit={handleSubmit} className="card space-y-6">
        {/* Server Name */}
        <div className="flex items-end gap-4">
          <div className="flex-1 min-w-0">
            <label className="block text-sm font-medium text-mc-text mb-2">
              Server Name <span className="text-mc-danger">*</span>
            </label>
            <input
              type="text"
              name="name"
              value={formData.name}
              onChange={handleChange}
              className="input"
              placeholder="My Awesome Server"
              required
            />
          </div>
          <div className="flex-shrink-0 pb-1">
            <div className="flex flex-col items-end gap-3">
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium text-mc-text">Java server</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={java}
                  aria-label="Create as a Java Edition server"
                  disabled={remote}
                  onClick={() => {
                    setJava((value) => {
                      const next = !value;
                      if (next) {
                        setRemote(false);
                        setFormData((prev) => {
                          const preferred = ipv4Available.find((item) => item.port === 25565)
                            || ipv4Available.find((item) => item.port !== 19132 && item.port !== 19133);
                          return {
                            ...prev,
                            port: preferred ? String(preferred.port) : prev.port,
                            maxPlayers: prev.maxPlayers === '10' ? '20' : prev.maxPlayers,
                            difficulty: prev.difficulty === 'peaceful' ? 'easy' : prev.difficulty,
                          };
                        });
                      }
                      return next;
                    });
                    setError('');
                  }}
                  className={`toggle ${java ? 'toggle-active' : 'toggle-inactive'} ${remote ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <span className={`toggle-thumb ${java ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>
              <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-mc-text">Remote server</span>
              <button
                type="button"
                role="switch"
                aria-checked={remote}
                aria-label="Create as a remote server"
                disabled={remoteCount >= MAX_REMOTE_SERVERS && !remote}
                onClick={() => {
                  if (remoteCount >= MAX_REMOTE_SERVERS && !remote) return;
                  setRemote((value) => {
                    const next = !value;
                    if (next) {
                      setJava(false);
                      setFormData((prev) => {
                        const v4 = Number(prev.port);
                        const v6 = Number(prev.ipv6Port);
                        const needsV4 = LAN_DISCOVERY_PORTS.has(v4);
                        const needsV6 = LAN_DISCOVERY_PORTS.has(v6);
                        if (!needsV4 && !needsV6) return prev;
                        const fallback = ipv4Available.find((item) => !LAN_DISCOVERY_PORTS.has(item.port));
                        const nextV4 = needsV4 && fallback ? fallback.port : v4;
                        const preferredV6 = nextV4 - 1000;
                        const match = ipv6Available.find((item) => item.port === preferredV6 && !LAN_DISCOVERY_PORTS.has(item.port))
                          || ipv6Available.find((item) => !LAN_DISCOVERY_PORTS.has(item.port));
                        return {
                          ...prev,
                          port: nextV4 ? String(nextV4) : prev.port,
                          ipv6Port: match ? String(match.port) : prev.ipv6Port,
                        };
                      });
                    }
                    return next;
                  });
                  setError('');
                }}
                className={`toggle ${remote ? 'toggle-active' : 'toggle-inactive'} ${remoteCount >= MAX_REMOTE_SERVERS && !remote ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <span className={`toggle-thumb ${remote ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>
            </div>
          </div>
        </div>
        {java && !remote && (
          <p className="text-xs text-mc-textMuted -mt-4">
            Downloads the official vanilla Minecraft Java Edition server.jar. Players connect with a Java Edition client on TCP.
            Geyser (Bedrock clients on Java) is not enabled yet.
          </p>
        )}
        {remote && (
          <p className="text-xs text-mc-textMuted -mt-4">
            This host listens on the local ports below and forwards UDP game traffic to another Bedrock server.
            At most {MAX_REMOTE_SERVERS} remote servers. Extra latency is expected, especially over a VPN.
          </p>
        )}
        {remoteCount >= MAX_REMOTE_SERVERS && !remote && (
          <p className="text-xs text-amber-300 -mt-4">
            Remote server limit reached ({MAX_REMOTE_SERVERS}). Delete one before adding another.
          </p>
        )}

        {/* Port Selection */}
        <div>
          <label className="block text-sm font-medium text-mc-text mb-2">
            IPv4 Port <span className="text-mc-danger">*</span>
          </label>
          <select
              name="port"
              value={formData.port}
              onChange={handleChange}
              className="input"
              required
            >
              <option value="">Select an available IPv4 port...</option>
              {ipv4Choices.map(({ port }) => (
                <option key={port} value={port}>{port}</option>
              ))}
          </select>
          <p className="mt-2 text-xs text-mc-textMuted">
            {remote
              ? 'UDP 19132 stays free so this host can advertise the remote as a LAN game. UDP 19133 is reserved for IPv6 discovery.'
              : java
                ? 'Java Edition listens on TCP. 25565 is used when it is free. UDP 19132/19133 stay reserved for Bedrock discovery.'
                : 'Defaults to the next free IPv4 port. UDP 19133 is reserved for IPv6 discovery.'}
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-mc-text mb-2">
            IPv6 Port <span className="text-mc-danger">*</span>
          </label>
          <select
              name="ipv6Port"
              value={formData.ipv6Port}
              onChange={handleChange}
              className={`input ${java ? 'opacity-50' : ''}`}
              disabled={java}
              required={!java}
            >
              <option value="">Select an available IPv6 port...</option>
              {ipv6Choices.map(({ port }) => (
                <option key={port} value={port}>{port}</option>
              ))}
          </select>
          <p className="mt-2 text-xs text-mc-textMuted">
            {java
              ? 'Java Edition uses one TCP port for IPv4 and IPv6. This Bedrock IPv6 port is unused.'
              : 'Defaults to 1000 below the IPv4 port when that IPv6 port is free.'}
          </p>
        </div>

        {remote && (
          <>
            <div>
              <label className="block text-sm font-medium text-mc-text mb-2">
                Remote IP or Hostname <span className="text-mc-danger">*</span>
              </label>
              <input
                type="text"
                name="remoteHost"
                value={formData.remoteHost}
                onChange={handleChange}
                className="input"
                placeholder="100.x.x.x or hostname"
                required={remote}
                autoComplete="off"
              />
              <p className="mt-2 text-xs text-mc-textMuted">
                Must resolve from this host. Tailscale and other VPN names work if this machine can reach them.
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-mc-text mb-2">
                Remote IPv4 Port <span className="text-mc-danger">*</span>
              </label>
              <input
                type="number"
                name="remoteIpv4Port"
                value={formData.remoteIpv4Port}
                onChange={handleChange}
                className="input"
                min="1"
                max="65535"
                required={remote}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-mc-text mb-2">
                Remote IPv6 Port <span className="text-mc-danger">*</span>
              </label>
              <input
                type="number"
                name="remoteIpv6Port"
                value={formData.remoteIpv6Port}
                onChange={handleChange}
                className="input"
                min="1"
                max="65535"
                required={remote}
              />
            </div>
          </>
        )}

        {!remote && (
          <>
        {/* Version */}
        <div>
          <label className="block text-sm font-medium text-mc-text mb-2">Version</label>
          <select
            name="version"
            value={formData.version}
            onChange={handleChange}
            className="input"
          >
            <option value="latest">Latest</option>
            {java
              ? javaVersions.filter((id) => id !== 'latest').map((id) => (
                <option key={id} value={id}>{id}</option>
              ))
              : (
                <>
                  <option value="1.20.80">1.20.80</option>
                  <option value="1.20.70">1.20.70</option>
                  <option value="1.20.60">1.20.60</option>
                  <option value="1.20.50">1.20.50</option>
                  <option value="1.20.40">1.20.40</option>
                </>
              )}
          </select>
        </div>

        {/* Max Players */}
        <div>
          <label className="block text-sm font-medium text-mc-text mb-2">Max Players</label>
          <input
            type="number"
            name="maxPlayers"
            value={formData.maxPlayers}
            onChange={handleChange}
            className="input"
            min="1"
            max="1000"
          />
        </div>

        {/* Gamemode */}
        <div>
          <label className="block text-sm font-medium text-mc-text mb-2">Game Mode</label>
          <select
            name="gamemode"
            value={formData.gamemode}
            onChange={handleChange}
            className="input"
          >
            <option value="survival">Survival</option>
            <option value="creative">Creative</option>
            <option value="adventure">Adventure</option>
            <option value="default">Default</option>
          </select>
        </div>

        {/* Difficulty */}
        <div>
          <label className="block text-sm font-medium text-mc-text mb-2">Difficulty</label>
          <select
            name="difficulty"
            value={formData.difficulty}
            onChange={handleChange}
            className="input"
          >
            <option value="peaceful">Peaceful</option>
            <option value="easy">Easy</option>
            <option value="normal">Normal</option>
            <option value="hard">Hard</option>
          </select>
        </div>

        {/* Description */}
        <div>
          <label className="block text-sm font-medium text-mc-text mb-2">Description</label>
          <textarea
            name="description"
            value={formData.description}
            onChange={handleChange}
            className="input resize-none"
            rows="3"
            placeholder="A short description for your server..."
          />
        </div>
        {java && (
          <label className="flex items-start gap-3 p-3 bg-mc-darker rounded-lg cursor-pointer">
            <input
              type="checkbox"
              checked={acceptEula}
              onChange={(e) => setAcceptEula(e.target.checked)}
              className="mt-1"
              required={java}
            />
            <span className="text-sm text-mc-text">
              I agree to the{' '}
              <a
                href="https://aka.ms/MinecraftEULA"
                target="_blank"
                rel="noreferrer"
                className="text-mc-accent hover:underline"
              >
                Minecraft EULA
              </a>
              . Required to run a Java Edition dedicated server.
            </span>
          </label>
        )}
          </>
        )}

        {/* Submit */}
        <div className="flex items-center gap-3 pt-4 border-t border-mc-surfaceLight">
          <button
            type="submit"
            disabled={loading || (java && !remote && !acceptEula)}
            title={java && !remote && !acceptEula ? 'Agree to the Minecraft EULA to create a Java server' : undefined}
            className="btn btn-primary flex-1"
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <Server className="w-4 h-4" />
                {remote ? 'Create Remote Server' : java ? 'Create Java Server' : 'Create Server'}
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="btn btn-secondary"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

export default CreateServer;
