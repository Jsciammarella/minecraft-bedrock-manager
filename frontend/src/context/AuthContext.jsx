import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { authApi } from '../services/api';
import { CREATE_SERVER_PERMISSIONS } from '../utils/menuVisibility';

const AuthContext = createContext(null);

const DEFAULT_FEATURES = {
  userManagement: false,
  roleManagement: false,
  passwordManagement: false,
};

const PERMISSION_ALIASES = {
  'dashboard.view': ['menu.view.dashboard'],
  'servers.view': ['menu.view.servers'],
  'library.view': ['menu.view.library'],
  'catalog.view': ['menu.view.catalog'],
  'players.view': ['menu.view.players'],
  'ports.view': ['menu.view.ports'],
  'plugins.view': ['menu.view.plugins'],
  'users.view': ['menu.view.users'],
  'bedrock_connect.view': ['menu.view.bedrock_connect'],
  'servers.create_bedrock': ['servers.create'],
  'servers.create': ['servers.create_bedrock'],
  'bedrock_connect.create': ['servers.create_bedrock_connect'],
  'bedrock_connect.start': ['servers.start_bedrock_connect'],
  'bedrock_connect.stop': ['servers.stop_bedrock_connect'],
  'bedrock_connect.dns.enable_proxy': ['bedrock_connect.enable_dns_proxy'],
  'bedrock_connect.dns.set_upstream': ['bedrock_connect.set_upstream_dns'],
  'bedrock_connect.dns.add_override': ['bedrock_connect.set_dns_overrides'],
  'bedrock_connect.dns.edit_override': ['bedrock_connect.set_dns_overrides'],
  'bedrock_connect.dns.remove_override': ['bedrock_connect.set_dns_overrides'],
  'servers.remote.start_proxy': ['servers.start_remote'],
  'servers.remote.stop_proxy': ['servers.stop_remote'],
  'servers.manage_lan_broadcast': ['servers.set_lan'],
  'servers.console.view': ['servers.console'],
  'servers.console.send_commands': ['servers.console'],
  'servers.allowlist.add': ['servers.add_allowed_players'],
  'servers.allowlist.remove': ['servers.remove_allowed_players'],
  'servers.banlist.add': ['servers.add_banned_players'],
  'servers.banlist.remove': ['servers.remove_banned_players'],
  'servers.update_software': ['servers.update'],
  'servers.configure_auto_update': ['servers.update'],
  'servers.player_permissions.set_visitor': ['servers.change_player_permissions'],
  'servers.player_permissions.set_member': ['servers.change_player_permissions'],
  'servers.player_permissions.set_operator': ['servers.change_player_permissions'],
  'servers.player_permissions.reset': ['servers.change_player_permissions'],
  'servers.mods.install': ['servers.add_mods'],
  'servers.mods.remove': ['servers.remove_mods'],
  'servers.remote.change_local_port': ['servers.change_remote_local_ports'],
  'servers.remote.change_target_host': ['servers.change_remote_target'],
  'servers.remote.change_target_port': ['servers.change_remote_target'],
  'catalog.download_to_library': ['catalog.download_mods'],
  'catalog.download_mods': ['catalog.download_to_library'],
  'catalog.curseforge.configure': ['catalog.set_curseforge_key'],
  'catalog.git.configure': ['catalog.enable_git'],
  'catalog.git.sync': ['catalog.enable_git'],
  'catalog.file.configure': ['catalog.enable_file'],
  'library.delete_entry': ['library.delete'],
  'library.delete': ['library.delete_entry'],
  'library.edit_metadata': ['library.change_settings'],
  'library.add_file': ['library.change_settings'],
  'library.remove_file': ['library.change_settings'],
  'players.remove_allowlist_all': ['players.remove_whitelisted'],
  'players.remove_whitelisted': ['players.remove_allowlist_all'],
  'players.unban_all': ['players.ban_all'],
  'plugins.install': ['plugins.upload'],
  'plugins.upload': ['plugins.install'],
  'users.edit_name': ['users.change_name'],
  'users.reset_password': ['users.change_password'],
  'account.change_own_name': ['users.change_name'],
  'account.change_own_password': ['users.change_password'],
  'users.assign_permissions': ['users.change_user_permissions'],
  'users.assign_groups': ['users.change_group_membership'],
  'groups.assign_permissions': ['users.change_group_permissions'],
  'groups.add_members': ['users.change_group_membership'],
  'groups.remove_members': ['users.change_group_membership'],
  'groups.create': ['users.add_groups'],
  'groups.delete': ['users.delete_groups'],
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
  const [needsBootstrap, setNeedsBootstrap] = useState(false);

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
    if (payload.needsBootstrap != null) setNeedsBootstrap(Boolean(payload.needsBootstrap));
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
    applySession({ ...res.data, needsBootstrap: false });
    setUser(res.data.user);
    return res.data.user;
  }, [applySession]);

  const bootstrap = useCallback(async ({ username, password, fullName }) => {
    setError('');
    const res = await authApi.bootstrap({ username, password, fullName });
    applySession({ ...res.data, needsBootstrap: false });
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
    const perms = Array.isArray(user.permissions) ? user.permissions : [];
    const aliases = PERMISSION_ALIASES[key] || [];
    const keys = [key, ...aliases];
    return keys.some((item) => perms.includes(item) || permissionList.includes(item));
  }, [user, permissionList]);

  const canAny = useCallback((...keys) => keys.some((key) => can(key)), [can]);

  const value = useMemo(() => {
    const isAdmin = Boolean(user?.isAdmin);
    const userManagementEnabled = Boolean(features.userManagement);
    const canViewUsers = userManagementEnabled && (isAdmin || can('users.view'));
    const canViewGroups = userManagementEnabled && (isAdmin || can('groups.view'));
    const canViewPermissions = userManagementEnabled && (isAdmin || canAny(
      'permissions.view_catalog',
      'permissions.view_assignments',
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
      needsBootstrap,
      login,
      bootstrap,
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
        'users.view',
        'groups.view',
        'permissions.view_catalog',
      )),
      canCreateAnyServer: canAny(...CREATE_SERVER_PERMISSIONS),
    };
  }, [
    user, loading, error, securityError, securityProfile, authenticationRequired,
    features, networkWarning, needsBootstrap, login, bootstrap, logout, refresh, can, canAny,
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
  if (kind === 'bedrock_connect') return 'bedrock_connect.start';
  if (kind === 'remote') return 'servers.remote.start_proxy';
  if (kind === 'java') return 'servers.start_java';
  return 'servers.start';
}

export function stopPermissionForKind(kind) {
  if (kind === 'bedrock_connect') return 'bedrock_connect.stop';
  if (kind === 'remote') return 'servers.remote.stop_proxy';
  if (kind === 'java') return 'servers.stop_java';
  return 'servers.stop';
}
