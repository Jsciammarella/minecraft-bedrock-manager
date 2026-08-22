import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, ArrowLeft, Loader2, Plus, Radio, Square, Play, RotateCcw, Trash2 } from 'lucide-react';
import { gatewayApi } from '../services/api';
import { useApi } from '../context/ApiContext';

function Gateways() {
  const navigate = useNavigate();
  const { servers } = useApi();
  const [gateways, setGateways] = useState([]);
  const [providers, setProviders] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [confirmOffline, setConfirmOffline] = useState(false);
  const [confirmFloodgate, setConfirmFloodgate] = useState(false);
  const [form, setForm] = useState({
    name: '',
    providerId: 'geyser',
    targetType: 'local-server',
    targetServerId: '',
    targetHost: '',
    targetTcpPort: '25565',
    bedrockUdpPort: '',
    authentication: 'online',
  });

  const javaServers = (servers || []).filter((server) => server.kind === 'java');

  const load = () => {
    gatewayApi.list().then((res) => setGateways(res.data?.gateways || [])).catch(() => setError('Could not load gateways.'));
    gatewayApi.providers().then((res) => setProviders(res.data?.providers || [])).catch(() => {});
  };

  useEffect(() => { load(); }, []);

  const create = async (event) => {
    event.preventDefault();
    setError('');
    setBusy('create');
    try {
      await gatewayApi.create({
        ...form,
        targetServerId: form.targetServerId ? Number(form.targetServerId) : undefined,
        targetTcpPort: form.targetTcpPort ? Number(form.targetTcpPort) : undefined,
        bedrockUdpPort: form.bedrockUdpPort ? Number(form.bedrockUdpPort) : undefined,
        confirmOffline,
        confirmFloodgate,
      });
      setShowCreate(false);
      setConfirmOffline(false);
      setConfirmFloodgate(false);
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy('');
    }
  };

  const act = async (id, fn) => {
    setError('');
    setBusy(id);
    try {
      await fn(id);
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <div className="page-header flex items-center gap-4 mb-8">
        <button onClick={() => navigate(-1)} className="p-2 hover:bg-mc-surfaceLight rounded-lg">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-white">Geyser</h1>
          <p className="text-mc-textMuted mt-1">
            Powered by Geyser. Standalone gateways translate Bedrock UDP to a Java TCP server. Not affiliated with GeyserMC or Mojang.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
          <Plus className="w-4 h-4" /> Add gateway
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400 flex gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
        </div>
      )}

      {showCreate && (
        <form onSubmit={create} className="card mb-6 space-y-4">
          <h2 className="font-semibold text-white">New Geyser Standalone gateway</h2>
          <input className="input" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          <select className="input" value={form.providerId} onChange={(e) => setForm({ ...form, providerId: e.target.value })}>
            {(providers.length ? providers : [{ id: 'geyser', name: 'Geyser' }]).map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
          <select className="input" value={form.targetType} onChange={(e) => setForm({ ...form, targetType: e.target.value })}>
            <option value="local-server">Local Java server</option>
            <option value="remote-address">Remote Java address</option>
          </select>
          {form.targetType === 'local-server' ? (
            <select className="input" value={form.targetServerId} onChange={(e) => setForm({ ...form, targetServerId: e.target.value })} required>
              <option value="">Select a Java server</option>
              {javaServers.map((server) => (
                <option key={server.id} value={server.id}>{server.name} (TCP {server.port})</option>
              ))}
            </select>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <input className="input" placeholder="Hostname or IP" value={form.targetHost} onChange={(e) => setForm({ ...form, targetHost: e.target.value })} required />
              <input className="input" type="number" placeholder="TCP port" value={form.targetTcpPort} onChange={(e) => setForm({ ...form, targetTcpPort: e.target.value })} required />
            </div>
          )}
          <input className="input" placeholder="Bedrock UDP port (optional)" value={form.bedrockUdpPort} onChange={(e) => setForm({ ...form, bedrockUdpPort: e.target.value })} />
          <select className="input" value={form.authentication} onChange={(e) => setForm({ ...form, authentication: e.target.value })}>
            <option value="online">Online (recommended)</option>
            <option value="floodgate">Floodgate</option>
            <option value="offline">Offline (insecure)</option>
          </select>
          {form.authentication === 'offline' && (
            <label className="flex items-start gap-2 text-sm text-amber-300">
              <input type="checkbox" checked={confirmOffline} onChange={(e) => setConfirmOffline(e.target.checked)} />
              I understand offline mode disables Java authentication and must not be used on a public network.
            </label>
          )}
          {form.authentication === 'floodgate' && form.targetType === 'remote-address' && (
            <label className="flex items-start gap-2 text-sm text-mc-text">
              <input type="checkbox" checked={confirmFloodgate} onChange={(e) => setConfirmFloodgate(e.target.checked)} />
              The remote Java server already has Floodgate installed and configured.
            </label>
          )}
          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={busy === 'create'}>
              {busy === 'create' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Create'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setShowCreate(false)}>Cancel</button>
          </div>
        </form>
      )}

      <div className="space-y-3">
        {gateways.length === 0 && (
          <div className="card text-sm text-mc-textMuted">No Geyser gateways yet. Standalone is recommended for remote or older Java servers.</div>
        )}
        {gateways.map((gateway) => (
          <div key={gateway.id} className="card">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <Radio className="w-4 h-4 text-mc-accent" />
                  <h3 className="text-white font-semibold">{gateway.name}</h3>
                  <span className="text-xs text-mc-textMuted">{gateway.status}</span>
                </div>
                <p className="text-sm text-mc-textMuted mt-1">
                  Bedrock UDP {gateway.bedrock_udp_port} → {gateway.target_host}:{gateway.target_tcp_port} ({gateway.authentication})
                </p>
              </div>
              <div className="flex gap-2">
                {gateway.status === 'running' ? (
                  <button className="btn btn-secondary" disabled={busy === gateway.id} onClick={() => act(gateway.id, gatewayApi.stop)}><Square className="w-4 h-4" /></button>
                ) : (
                  <button className="btn btn-primary" disabled={busy === gateway.id} onClick={() => act(gateway.id, gatewayApi.start)}><Play className="w-4 h-4" /></button>
                )}
                <button className="btn btn-secondary" disabled={busy === gateway.id} onClick={() => act(gateway.id, gatewayApi.restart)}><RotateCcw className="w-4 h-4" /></button>
                <button className="btn btn-secondary" disabled={busy === gateway.id} onClick={() => act(gateway.id, gatewayApi.remove)}><Trash2 className="w-4 h-4" /></button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default Gateways;
