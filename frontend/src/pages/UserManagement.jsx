import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Users, UsersRound, Shield, Settings } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

const TILES = [
  { to: '/users', end: true, label: 'Users', description: 'Accounts and access', icon: Users, show: (auth) => auth.canViewUsers },
  { to: '/users/groups', label: 'Groups', description: 'Shared permission sets', icon: UsersRound, show: (auth) => auth.canViewGroups },
  { to: '/users/permissions', label: 'Permissions', description: 'Available platform rights', icon: Shield, show: (auth) => auth.canViewPermissions },
  { to: '/users/settings', label: 'Settings', description: 'Password and platform options', icon: Settings, show: (auth) => auth.canViewSettings },
];

function UserManagement() {
  const auth = useAuth();
  const location = useLocation();
  const isDetail = /^\/users\/\d+/.test(location.pathname)
    || /^\/users\/groups\/\d+/.test(location.pathname);
  const tiles = TILES.filter((tile) => tile.show(auth));

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto">
      {!isDetail && (
        <>
          <div className="page-header mb-8">
            <h1 className="text-2xl font-bold text-white">User Management</h1>
            <p className="text-mc-textMuted mt-1">Manage accounts, groups, and platform permissions</p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
            {tiles.map((tile) => {
              const Icon = tile.icon;
              return (
                <NavLink
                  key={tile.to}
                  to={tile.to}
                  end={tile.end}
                  className={({ isActive }) => `card transition-colors hover:border-mc-accent/40 ${
                    isActive ? 'border-mc-accent/60 bg-mc-accent/5' : ''
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-mc-textMuted">{tile.description}</p>
                      <p className="text-xl font-bold text-white mt-1">{tile.label}</p>
                    </div>
                    <div className="w-10 h-10 bg-mc-accent/15 rounded-lg flex items-center justify-center">
                      <Icon className="w-5 h-5 text-mc-accent" />
                    </div>
                  </div>
                </NavLink>
              );
            })}
          </div>
        </>
      )}
      <Outlet />
    </div>
  );
}

export default UserManagement;
