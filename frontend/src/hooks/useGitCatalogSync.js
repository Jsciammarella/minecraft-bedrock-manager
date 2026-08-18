import { useCallback, useEffect, useState } from 'react';
import { modApi } from '../services/api';

const emptyStatus = {
  running: false,
  startedAt: null,
  error: '',
  lastSync: '',
  modCount: 0,
  canSync: false,
};

export function useGitCatalogSync() {
  const [status, setStatus] = useState(emptyStatus);

  const refreshStatus = useCallback(async () => {
    const res = await modApi.gitCatalogSyncStatus();
    const next = { ...emptyStatus, ...res.data };
    setStatus(next);
    return next;
  }, []);

  useEffect(() => {
    let cancelled = false;
    refreshStatus().catch(() => {
      if (!cancelled) setStatus(emptyStatus);
    });
    return () => {
      cancelled = true;
    };
  }, [refreshStatus]);

  useEffect(() => {
    if (!status.running) return undefined;
    const timer = setInterval(() => {
      refreshStatus().catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [status.running, refreshStatus]);

  const startSync = useCallback(async () => {
    const res = await modApi.syncGitCatalog();
    const next = { ...emptyStatus, ...res.data };
    setStatus(next);
    return next;
  }, []);

  return { status, setStatus, refreshStatus, startSync };
}
