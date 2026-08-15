import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { serverApi } from '../services/api';

const ApiContext = createContext(null);

export function ApiProvider({ children }) {
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Debounce ref to avoid too many rapid refreshes from real-time events
  const refreshTimerRef = useRef(null);

  const fetchServers = useCallback(async () => {
    try {
      const res = await serverApi.getAll();
      setServers(res.data);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchServers();
    const interval = setInterval(fetchServers, 5 * 60 * 1000);

    const handleStatusChange = (event) => {
      const detail = event.detail || {};
      if (detail.serverId != null && detail.status) {
        setServers((prev) => prev.map((server) => (
          String(server.id) === String(detail.serverId)
            ? { ...server, status: detail.status }
            : server
        )));
      }
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null;
        fetchServers();
      }, 500);
    };

    window.addEventListener('server-status-change', handleStatusChange);

    return () => {
      clearInterval(interval);
      window.removeEventListener('server-status-change', handleStatusChange);
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, [fetchServers]);

  const hasCreating = servers.some((server) => server.status === 'creating');
  useEffect(() => {
    if (!hasCreating) return undefined;
    const interval = setInterval(fetchServers, 2000);
    return () => clearInterval(interval);
  }, [fetchServers, hasCreating]);

  const refresh = useCallback(() => {
    setLoading(true);
    return fetchServers();
  }, [fetchServers]);

  return (
    <ApiContext.Provider value={{ servers, loading, error, refresh, setServers }}>
      {children}
    </ApiContext.Provider>
  );
}

export function useApi() {
  const context = useContext(ApiContext);
  if (!context) throw new Error('useApi must be used within ApiProvider');
  return context;
}
