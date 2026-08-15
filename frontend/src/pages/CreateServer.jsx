import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { serverApi, portApi } from '../services/api';
import { useApi } from '../context/ApiContext';
import { ArrowLeft, Server, Loader2, Check, AlertCircle } from 'lucide-react';

function CreateServer() {
  const navigate = useNavigate();
  const { refresh } = useApi();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  
  const [formData, setFormData] = useState({
    name: '',
    port: '',
    ipv6Port: '',
    version: 'latest',
    maxPlayers: '10',
    description: '',
    gamemode: 'survival',
    difficulty: 'peaceful',
  });

  const [ports, setPorts] = useState({ used: [], available: [] });

  useEffect(() => {
    loadPorts();
  }, []);

  const ipv4Available = (ports.available || []).filter((item) => item.family !== 'ipv6');
  const ipv6Available = (ports.available || []).filter((item) => item.family === 'ipv6');

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

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => {
      const next = { ...prev, [name]: value };
      if (name === 'port') {
        const v4 = parseInt(value, 10);
        const preferredV6 = v4 - 1000;
        const match = ipv6Available.find((item) => item.port === preferredV6)
          || ipv6Available[0];
        if (match) next.ipv6Port = String(match.port);
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
      await serverApi.create({
        ...formData,
        port: parseInt(formData.port, 10),
        ipv6Port: formData.ipv6Port === '' ? undefined : parseInt(formData.ipv6Port, 10),
        maxPlayers: parseInt(formData.maxPlayers, 10),
      });
      await refresh();
      navigate('/');
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to create server');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-6 max-w-2xl mx-auto">
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
          <p className="text-mc-textMuted mt-1">Set up a new Minecraft Bedrock server</p>
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
        <div>
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
              {ipv4Available.map(({ port }) => (
                <option key={port} value={port}>{port}</option>
              ))}
          </select>
          <p className="mt-2 text-xs text-mc-textMuted">
            Defaults to the next free IPv4 port. UDP 19133 is reserved for IPv6 discovery.
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
              className="input"
              required
            >
              <option value="">Select an available IPv6 port...</option>
              {ipv6Available.map(({ port }) => (
                <option key={port} value={port}>{port}</option>
              ))}
          </select>
          <p className="mt-2 text-xs text-mc-textMuted">
            Defaults to 1000 below the IPv4 port when that IPv6 port is free.
          </p>
        </div>

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
            <option value="1.20.80">1.20.80</option>
            <option value="1.20.70">1.20.70</option>
            <option value="1.20.60">1.20.60</option>
            <option value="1.20.50">1.20.50</option>
            <option value="1.20.40">1.20.40</option>
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

        {/* Submit */}
        <div className="flex items-center gap-3 pt-4 border-t border-mc-surfaceLight">
          <button
            type="submit"
            disabled={loading}
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
                Create Server
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
