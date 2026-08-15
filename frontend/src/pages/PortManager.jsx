import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { portApi } from '../services/api';
import {
  ArrowLeft, Network, Search, AlertCircle, Check, Loader2, Server, Lock, Unlock
} from 'lucide-react';

function PortManager() {
  const navigate = useNavigate();
  const [ports, setPorts] = useState({ used: [], available: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all'); // all, used, available

  useEffect(() => {
    loadPorts();
  }, []);

  const loadPorts = async () => {
    try {
      const res = await portApi.getAll();
      setPorts(res.data);
    } catch (err) {
      setError('Failed to load ports');
    } finally {
      setLoading(false);
    }
  };

  const filteredUsed = search
    ? ports.used.filter(p => String(p.port).includes(search) || (p.server_name && p.server_name.toLowerCase().includes(search.toLowerCase())))
    : ports.used;

  const filteredAvailable = search
    ? ports.available.filter(p => String(p.port).includes(search))
    : ports.available;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-mc-accent animate-spin" />
          <p className="text-sm text-mc-textMuted">Loading ports...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <button onClick={() => navigate(-1)} className="p-2 hover:bg-mc-surfaceLight rounded-lg transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-2xl font-bold text-white">Port Manager</h1>
            <p className="text-mc-textMuted mt-1">Track and manage server ports</p>
          </div>
        </div>
      </div>

      {/* Messages */}
      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Search & Filter */}
      <div className="card mb-6">
        <div className="flex flex-col md:flex-row gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-mc-textMuted" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input pl-10"
              placeholder="Search ports or server names..."
            />
          </div>
          <div className="flex items-center gap-2">
            {['all', 'used', 'available'].map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`btn text-sm ${filter === f ? 'btn-primary' : 'btn-secondary'}`}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Summary */}
        <div className="mt-4 pt-4 border-t border-mc-surfaceLight grid grid-cols-3 gap-4">
          <div className="text-center">
            <p className="text-2xl font-bold text-white">{ports.used.length}</p>
            <p className="text-xs text-mc-textMuted">Ports in Use</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold text-green-400">{ports.available.length}</p>
            <p className="text-xs text-mc-textMuted">Available Ports</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold text-blue-400">{new Set(ports.used.map(p => p.server_name)).size}</p>
            <p className="text-xs text-mc-textMuted">Active Servers</p>
          </div>
        </div>
      </div>

      {/* Used Ports */}
      {(filter === 'all' || filter === 'used') && (
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-white mb-3 flex items-center gap-2">
            <Lock className="w-4 h-4 text-red-400" />
            Used Ports
            <span className="text-sm font-normal text-mc-textMuted">({filteredUsed.length})</span>
          </h2>
          {filteredUsed.length === 0 ? (
            <div className="card text-center py-8">
              <Network className="w-12 h-12 text-mc-textMuted mx-auto mb-3" />
              <p className="text-mc-textMuted">No ports currently in use</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {filteredUsed.map((port, idx) => (
                <div key={`${port.port}-${port.protocol}-${idx}`} className="card flex items-center gap-3 p-4">
                  <div className="w-10 h-10 bg-red-500/20 rounded-lg flex items-center justify-center flex-shrink-0">
                    <Lock className="w-5 h-5 text-red-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-lg font-bold text-white">{port.port}</p>
                    <p className="text-xs text-mc-textMuted capitalize">{port.protocol}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-medium text-white truncate max-w-[120px]" title={port.server_name}>
                      {port.server_name || 'Unknown'}
                    </p>
                    <p className="text-xs text-mc-textMuted">in use</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Available Ports */}
      {(filter === 'all' || filter === 'available') && (
        <div>
          <h2 className="text-lg font-semibold text-white mb-3 flex items-center gap-2">
            <Unlock className="w-4 h-4 text-green-400" />
            Available Ports
            <span className="text-sm font-normal text-mc-textMuted">({filteredAvailable.length})</span>
          </h2>
          {filteredAvailable.length === 0 ? (
            <div className="card text-center py-8">
              <Network className="w-12 h-12 text-mc-textMuted mx-auto mb-3" />
              <p className="text-mc-textMuted">No available ports found</p>
            </div>
          ) : (
            <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 gap-2">
              {filteredAvailable.map((port, idx) => (
                <div
                  key={`${port.port}-${idx}`}
                  className="bg-mc-darker border border-mc-surfaceLight rounded-lg p-3 text-center hover:border-green-500/30 transition-colors"
                >
                  <p className="text-sm font-bold text-green-400">{port.port}</p>
                  <p className="text-xs text-mc-textMuted mt-1">free</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default PortManager;
