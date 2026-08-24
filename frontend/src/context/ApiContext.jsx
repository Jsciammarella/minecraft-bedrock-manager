import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { serverApi, dashboardApi } from '../services/api';

const ApiContext = createContext(null);

export function ApiProvider({ children }) {
  const [servers, setServers] = useState([]);
  const [gateways, setGateways] = useState([]);
  const [javaHostingAvailable, setJavaHostingAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Debounce ref to avoid too many rapid refreshes from real-time events
  const refreshTimerRef = useRef(null);

  const fetchServers = useCallback(async () => {
    try {
      const [res, dash] = await Promise.all([
        serverApi.getAll(),
        dashboardApi.list().catch(() => ({ data: { gateways: [] } })),
      ]);
      setServers(res.data);
      setGateways(Array.isArray(dash.data?.gateways) ? dash.data.gateways : []);
      if (dash.data && Object.prototype.hasOwnProperty.call(dash.data, 'javaHostingAvailable')) {
        setJavaHostingAvailable(Boolean(dash.data.javaHostingAvailable));
      }
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
      if (detail.serverId != null && (detail.status || detail.remoteReachable !== undefined)) {
        setServers((prev) => prev.map((server) => (
          String(server.id) === String(detail.serverId)
            ? {
                ...server,
                ...(detail.status ? { status: detail.status } : {}),
                ...(detail.remoteReachable !== undefined ? { remoteReachable: detail.remoteReachable } : {}),
              }
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

  const hasTransient = servers.some((server) => (
    server.status === 'creating' || server.status === 'starting'
  ));
  useEffect(() => {
    if (!hasTransient) return undefined;
    const interval = setInterval(fetchServers, 2000);
    return () => clearInterval(interval);
  }, [fetchServers, hasTransient]);

  const refresh = useCallback(() => {
    setLoading(true);
    return fetchServers();
  }, [fetchServers]);

  return (
    <ApiContext.Provider value={{ servers, gateways, javaHostingAvailable, loading, error, refresh, setServers }}>
      {children}
    </ApiContext.Provider>
  );
}

export function useApi() {
  const context = useContext(ApiContext);
  if (!context) throw new Error('useApi must be used within ApiProvider');
  return context;
}
