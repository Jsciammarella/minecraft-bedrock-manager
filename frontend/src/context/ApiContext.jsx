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
    // Dashboard/global data refreshes every five minutes. Server details poll separately.
    const interval = setInterval(fetchServers, 5 * 60 * 1000);

    // Listen for real-time status changes from Socket.IO
    const handleStatusChange = () => {
      // Debounce: only refresh once per 2-second window
      if (refreshTimerRef.current) return;
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null;
        fetchServers();
      }, 2000);
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
