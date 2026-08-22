import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { authApi } from '../services/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const res = await authApi.me();
      setUser(res.data.user || null);
      setError('');
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const onExpired = () => {
      setUser(null);
    };
    window.addEventListener('mbm-auth-expired', onExpired);
    return () => window.removeEventListener('mbm-auth-expired', onExpired);
  }, []);

  const login = useCallback(async (username, password) => {
    setError('');
    const res = await authApi.login(username, password);
    setUser(res.data.user);
    return res.data.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      /* ignore */
    }
    setUser(null);
  }, []);

  const can = useCallback((key) => {
    if (!user) return false;
    if (user.isAdmin) return true;
    return Array.isArray(user.permissions) && user.permissions.includes(key);
  }, [user]);

  const canAny = useCallback((...keys) => keys.some((key) => can(key)), [can]);

  const value = useMemo(() => {
    const isAdmin = Boolean(user?.isAdmin);
    const canViewUsers = isAdmin || canAny(
      'users.change_password',
      'users.change_name',
      'users.change_user_permissions',
      'users.change_group_membership',
    );
    const canViewGroups = isAdmin || canAny(
      'users.add_groups',
      'users.delete_groups',
      'users.change_group_membership',
      'users.change_group_permissions',
    );
    const canViewPermissions = isAdmin || canAny(
      'users.change_user_permissions',
      'users.change_group_permissions',
    );
    return {
      user,
      loading,
      error,
      setError,
      login,
      logout,
      refresh,
      can,
      canAny,
      isAdmin,
      canViewUsers,
      canViewGroups,
      canViewPermissions,
      canViewSettings: isAdmin || canAny(
        'users.change_password',
        'users.change_name',
        'users.change_user_permissions',
        'users.change_group_permissions',
        'users.change_group_membership',
        'users.add_groups',
        'users.delete_groups',
      ),
      canAccessUserManagement: isAdmin || canAny(
        'users.change_password',
        'users.change_name',
        'users.change_user_permissions',
        'users.change_group_permissions',
        'users.change_group_membership',
        'users.add_groups',
        'users.delete_groups',
      ),
    };
  }, [user, loading, error, login, logout, refresh, can, canAny]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}

export function startPermissionForKind(kind) {
  if (kind === 'bedrock_connect') return 'servers.start_bedrock_connect';
  if (kind === 'remote') return 'servers.start_remote';
  return 'servers.start';
}

export function stopPermissionForKind(kind) {
  if (kind === 'bedrock_connect') return 'servers.stop_bedrock_connect';
  if (kind === 'remote') return 'servers.stop_remote';
  return 'servers.stop';
}
