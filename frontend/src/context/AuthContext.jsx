import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { authApi } from '../services/api';

const AuthContext = createContext(null);

const DEFAULT_FEATURES = {
  userManagement: false,
  roleManagement: false,
  passwordManagement: false,
};

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [securityError, setSecurityError] = useState('');
  const [securityProfile, setSecurityProfile] = useState('');
  const [authenticationRequired, setAuthenticationRequired] = useState(true);
  const [features, setFeatures] = useState(DEFAULT_FEATURES);
  const [permissionList, setPermissionList] = useState([]);
  const [networkWarning, setNetworkWarning] = useState(false);

  const applySession = useCallback((data) => {
    const payload = data || {};
    if (payload.securityProfile) setSecurityProfile(payload.securityProfile);
    if (payload.authenticationRequired != null) {
      setAuthenticationRequired(Boolean(payload.authenticationRequired));
    }
    if (payload.features && typeof payload.features === 'object') {
      setFeatures({ ...DEFAULT_FEATURES, ...payload.features });
    }
    if (Array.isArray(payload.permissions)) setPermissionList(payload.permissions);
    if (payload.networkWarning != null) setNetworkWarning(Boolean(payload.networkWarning));
    if (payload.user) setUser(payload.user);
  }, []);

  const refresh = useCallback(async () => {
    try {
      let info;
      try {
        info = (await authApi.security()).data;
      } catch {
        setSecurityError('Could not load security configuration');
        setAuthenticationRequired(true);
        setUser(null);
        return;
      }
      setSecurityError('');
      if (!info || info.authenticationRequired == null || !info.securityProfile) {
        setSecurityError('Security configuration was incomplete');
        setAuthenticationRequired(true);
        setUser(null);
        return;
      }
      applySession(info);
      if (info.authenticationRequired) {
        try {
          const res = await authApi.me();
          applySession(res.data);
          setError('');
        } catch {
          setUser(null);
        }
        return;
      }
      const res = await authApi.me();
      applySession(res.data);
      setError('');
    } catch {
      setSecurityError('Could not load the application session');
      setAuthenticationRequired(true);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, [applySession]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const onExpired = () => {
      if (authenticationRequired) setUser(null);
    };
    window.addEventListener('mbm-auth-expired', onExpired);
    return () => window.removeEventListener('mbm-auth-expired', onExpired);
  }, [authenticationRequired]);

  const login = useCallback(async (username, password) => {
    setError('');
    const res = await authApi.login(username, password);
    applySession(res.data);
    setUser(res.data.user);
    return res.data.user;
  }, [applySession]);

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
    if (Array.isArray(user.permissions) && user.permissions.includes(key)) return true;
    return permissionList.includes(key);
  }, [user, permissionList]);

  const canAny = useCallback((...keys) => keys.some((key) => can(key)), [can]);

  const value = useMemo(() => {
    const isAdmin = Boolean(user?.isAdmin);
    const userManagementEnabled = Boolean(features.userManagement);
    const canViewUsers = userManagementEnabled && (isAdmin || canAny(
      'users.change_password',
      'users.change_name',
      'users.change_user_permissions',
      'users.change_group_membership',
    ));
    const canViewGroups = userManagementEnabled && (isAdmin || canAny(
      'users.add_groups',
      'users.delete_groups',
      'users.change_group_membership',
      'users.change_group_permissions',
    ));
    const canViewPermissions = userManagementEnabled && (isAdmin || canAny(
      'users.change_user_permissions',
      'users.change_group_permissions',
    ));
    return {
      user,
      loading,
      error,
      setError,
      securityError,
      securityProfile,
      authenticationRequired,
      features,
      networkWarning,
      login,
      logout,
      refresh,
      can,
      canAny,
      isAdmin,
      canViewUsers,
      canViewGroups,
      canViewPermissions,
      canViewSettings: Boolean(user) && (userManagementEnabled || features.passwordManagement || authenticationRequired),
      canAccessUserManagement: userManagementEnabled && (isAdmin || canAny(
        'users.change_password',
        'users.change_name',
        'users.change_user_permissions',
        'users.change_group_permissions',
        'users.change_group_membership',
        'users.add_groups',
        'users.delete_groups',
      )),
    };
  }, [
    user, loading, error, securityError, securityProfile, authenticationRequired,
    features, networkWarning, login, logout, refresh, can, canAny,
  ]);

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
  if (kind === 'java') return 'servers.start_java';
  return 'servers.start';
}

export function stopPermissionForKind(kind) {
  if (kind === 'bedrock_connect') return 'servers.stop_bedrock_connect';
  if (kind === 'remote') return 'servers.stop_remote';
  if (kind === 'java') return 'servers.stop_java';
  return 'servers.stop';
}
