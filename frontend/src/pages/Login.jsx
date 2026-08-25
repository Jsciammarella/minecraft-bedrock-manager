import { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Loader2, Server } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { authApi } from '../services/api';
import { DEFAULT_PASSWORD_POLICY, validateLogin } from '../utils/passwordPolicy';

function Login() {
  const { user, loading, login, authenticationRequired, securityError } = useAuth();
  const location = useLocation();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [policy, setPolicy] = useState(DEFAULT_PASSWORD_POLICY);

  useEffect(() => {
    if (!authenticationRequired) return undefined;
    authApi.passwordPolicy()
      .then((res) => setPolicy(res.data || DEFAULT_PASSWORD_POLICY))
      .catch(() => setPolicy(DEFAULT_PASSWORD_POLICY));
    return undefined;
  }, [authenticationRequired]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-mc-dark">
        <Loader2 className="w-8 h-8 text-mc-accent animate-spin" />
      </div>
    );
  }

  if (securityError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-mc-dark p-6">
        <div className="card max-w-md text-center space-y-3">
          <h1 className="text-xl font-bold text-white">Unable to load security configuration</h1>
          <p className="text-sm text-mc-textMuted">{securityError}</p>
        </div>
      </div>
    );
  }

  if (!authenticationRequired || user) {
    const dest = location.state?.from || '/';
    return <Navigate to={dest} replace />;
  }

  const handleSubmit = async (event) => {
    event.preventDefault();
    const validationError = validateLogin(username, password, policy);
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await login(username, password);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-mc-dark flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-3 mb-8 justify-center">
          <div className="w-12 h-12 bg-mc-accent rounded-xl flex items-center justify-center">
            <Server className="w-7 h-7 text-mc-darker" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">MC Manager</h1>
            <p className="text-sm text-mc-textMuted">Sign in to continue</p>
          </div>
        </div>
        <form onSubmit={handleSubmit} className="card space-y-4">
          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-sm text-red-400">
              {error}
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-mc-text mb-2" htmlFor="username">Username</label>
            <input
              id="username"
              name="username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="input"
              required
              autoFocus
              minLength={policy.usernameMin}
              maxLength={policy.usernameMax}
            />
            <p className="text-xs text-mc-textMuted mt-2">
              {policy.usernameMin}–{policy.usernameMax} characters. Use {policy.usernameAllowed} only.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-mc-text mb-2" htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input"
              required
              maxLength={policy.maxLength}
            />
          </div>
          <button type="submit" disabled={busy} className="btn btn-primary w-full">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {busy ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default Login;
