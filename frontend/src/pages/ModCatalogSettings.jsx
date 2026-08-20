import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { modApi } from '../services/api';
import { useGitCatalogSync } from '../hooks/useGitCatalogSync';
import {
  ArrowLeft, Save, Loader2, Check, AlertCircle, RefreshCw, Eye, EyeOff, GitBranch, Folder
} from 'lucide-react';

function ModCatalogSettings() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testingFile, setTestingFile] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [showCurseforgeKey, setShowCurseforgeKey] = useState(false);
  const [showGitToken, setShowGitToken] = useState(false);
  const { status, setStatus, startSync } = useGitCatalogSync();
  const wasSyncing = useRef(false);

  const [curseforgeApiKey, setCurseforgeApiKey] = useState('');
  const [curseforgeConfigured, setCurseforgeConfigured] = useState(false);
  const [clearCurseforgeApiKey, setClearCurseforgeApiKey] = useState(false);

  const [gitEnabled, setGitEnabled] = useState(false);
  const [gitUrl, setGitUrl] = useState('');
  const [gitBranch, setGitBranch] = useState('main');
  const [gitUsername, setGitUsername] = useState('');
  const [gitToken, setGitToken] = useState('');
  const [gitTokenSet, setGitTokenSet] = useState(false);
  const [clearGitToken, setClearGitToken] = useState(false);
  const [gitSubdir, setGitSubdir] = useState('');
  const [gitLastSync, setGitLastSync] = useState('');
  const [gitModCount, setGitModCount] = useState(0);

  const [fileEnabled, setFileEnabled] = useState(true);
  const [fileModCount, setFileModCount] = useState(0);
  const [defaultLocalPath, setDefaultLocalPath] = useState('');
  const [localEnabled, setLocalEnabled] = useState(true);
  const [localPath, setLocalPath] = useState('');
  const [smbEnabled, setSmbEnabled] = useState(false);
  const [smbPath, setSmbPath] = useState('');
  const [smbUsername, setSmbUsername] = useState('');
  const [smbPassword, setSmbPassword] = useState('');
  const [smbPasswordSet, setSmbPasswordSet] = useState(false);
  const [clearSmbPassword, setClearSmbPassword] = useState(false);
  const [showSmbPassword, setShowSmbPassword] = useState(false);
  const [nfsEnabled, setNfsEnabled] = useState(false);
  const [nfsPath, setNfsPath] = useState('');

  useEffect(() => {
    loadSettings();
  }, []);

  useEffect(() => {
    if (wasSyncing.current && !status.running) {
      setGitLastSync(status.lastSync || '');
      setGitModCount(status.modCount || 0);
      if (status.error) {
        setError(status.error);
      } else if (status.lastSync) {
        setSuccess(`Git catalog synced (${status.modCount || 0} mods)`);
        setTimeout(() => setSuccess(''), 3000);
      }
    }
    wasSyncing.current = Boolean(status.running);
  }, [status]);

  const applyGitSync = (data) => {
    if (data?.git?.sync) setStatus((prev) => ({ ...prev, ...data.git.sync }));
    setGitLastSync(data?.git?.lastSync || data?.git?.sync?.lastSync || '');
    setGitModCount(data?.git?.modCount ?? data?.git?.sync?.modCount ?? 0);
  };

  const loadSettings = async () => {
    try {
      const res = await modApi.catalogSettings();
      const data = res.data;
      setCurseforgeConfigured(Boolean(data.curseforge?.configured));
      setGitEnabled(Boolean(data.git?.enabled));
      setGitUrl(data.git?.url || '');
      setGitBranch(data.git?.branch || 'main');
      setGitUsername(data.git?.username || '');
      setGitTokenSet(Boolean(data.git?.tokenSet));
      setGitSubdir(data.git?.subdir || '');
      applyGitSync(data);
      setFileEnabled(data.files?.enabled !== false);
      setFileModCount(data.files?.modCount || 0);
      setDefaultLocalPath(data.files?.defaultLocalPath || '');
      setLocalEnabled(data.files?.local?.enabled !== false);
      setLocalPath(data.files?.local?.path || '');
      setSmbEnabled(Boolean(data.files?.smb?.enabled));
      setSmbPath(data.files?.smb?.path || '');
      setSmbUsername(data.files?.smb?.username || '');
      setSmbPasswordSet(Boolean(data.files?.smb?.passwordSet));
      setNfsEnabled(Boolean(data.files?.nfs?.enabled));
      setNfsPath(data.files?.nfs?.path || '');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load catalog settings');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const payload = {
        git: {
          enabled: gitEnabled,
          url: gitUrl,
          branch: gitBranch,
          username: gitUsername,
          subdir: gitSubdir,
        },
        files: {
          enabled: fileEnabled,
          local: { enabled: localEnabled, path: localPath },
          smb: { enabled: smbEnabled, path: smbPath, username: smbUsername },
          nfs: { enabled: nfsEnabled, path: nfsPath },
        },
      };
      if (clearCurseforgeApiKey) payload.clearCurseforgeApiKey = true;
      else if (curseforgeApiKey.trim()) payload.curseforgeApiKey = curseforgeApiKey.trim();
      if (clearGitToken) payload.clearGitToken = true;
      else if (gitToken.trim()) payload.git.token = gitToken.trim();
      if (clearSmbPassword) payload.clearSmbPassword = true;
      else if (smbPassword.trim()) payload.files.smb.password = smbPassword.trim();

      const res = await modApi.saveCatalogSettings(payload);
      const data = res.data;
      setCurseforgeConfigured(Boolean(data.curseforge?.configured));
      setGitTokenSet(Boolean(data.git?.tokenSet));
      setSmbPasswordSet(Boolean(data.files?.smb?.passwordSet));
      setFileModCount(data.files?.modCount || 0);
      applyGitSync(data);
      setCurseforgeApiKey('');
      setGitToken('');
      setSmbPassword('');
      setClearCurseforgeApiKey(false);
      setClearGitToken(false);
      setClearSmbPassword(false);
      setSuccess(data.git?.sync?.running
        ? 'Catalog settings saved. Git catalog is syncing in the background.'
        : 'Catalog settings saved');
      setTimeout(() => setSuccess(''), 4000);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setError('');
    setSuccess('');
    try {
      await modApi.testGitCatalog({
        url: gitUrl,
        branch: gitBranch,
        username: gitUsername,
        token: gitToken.trim() || undefined,
      });
      setSuccess('Git repository is reachable');
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Git connection failed');
    } finally {
      setTesting(false);
    }
  };

  const handleTestFile = async (kind) => {
    setTestingFile(kind);
    setError('');
    setSuccess('');
    try {
      const payload = { kind };
      if (kind === 'local') payload.path = localPath;
      if (kind === 'smb') {
        payload.path = smbPath;
        payload.username = smbUsername;
        if (smbPassword.trim()) payload.password = smbPassword.trim();
      }
      if (kind === 'nfs') payload.path = nfsPath;
      const res = await modApi.testFileCatalog(payload);
      setSuccess(`${kind === 'local' ? 'Local folder' : kind.toUpperCase()} is reachable (${res.data.modCount || 0} mods)`);
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'File catalog test failed');
    } finally {
      setTestingFile('');
    }
  };

  const handleSync = async () => {
    if (!status.canSync || status.running) return;
    setError('');
    setSuccess('');
    try {
      await startSync();
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Git sync failed');
    }
  };

  const syncDisabled = !status.canSync || status.running;
  const syncTitle = status.running
    ? 'Git catalog is syncing'
    : !status.canSync
      ? 'Save settings with the Git catalog enabled and an access token to sync'
      : 'Sync Git catalog now';

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-mc-accent border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-mc-textMuted">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-4 mb-8">
        <button onClick={() => navigate('/mods/catalog')} className="p-2 hover:bg-mc-surfaceLight rounded-lg transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-2xl font-bold text-white">Catalog Settings</h1>
          <p className="text-mc-textMuted mt-1">Configure CurseForge, Git, and file catalog sources</p>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}
      {success && (
        <div className="mb-6 p-4 bg-green-500/10 border border-green-500/30 rounded-lg flex items-center gap-3">
          <Check className="w-5 h-5 text-green-400 flex-shrink-0" />
          <p className="text-sm text-green-400">{success}</p>
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-6">
        <Section title="CurseForge">
          <p className="text-sm text-mc-textMuted mb-4">
            Optional. A CurseForge API key makes search and downloads reliable. Without a key, the catalog still
            tries the public site, which CurseForge may block. Get a key from{' '}
            <a
              href="https://console.curseforge.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-mc-accent hover:underline"
            >
              the CurseForge console
            </a>
            .
          </p>
          <div className="flex items-center justify-between p-3 bg-mc-darker rounded-lg mb-4">
            <div>
              <p className="text-sm font-medium text-white">API key status</p>
              <p className="text-xs text-mc-textMuted">
                {curseforgeConfigured ? 'A key is configured' : 'No key configured'}
              </p>
            </div>
            <span className={`badge ${curseforgeConfigured ? 'badge-success' : 'badge-warning'}`}>
              {curseforgeConfigured ? 'Configured' : 'Not set'}
            </span>
          </div>
          <label className="block text-sm font-medium text-mc-text mb-2">API Key</label>
          <div className="relative">
            <input
              type={showCurseforgeKey ? 'text' : 'password'}
              value={curseforgeApiKey}
              onChange={(e) => {
                setCurseforgeApiKey(e.target.value);
                setClearCurseforgeApiKey(false);
              }}
              className="input pr-12"
              placeholder={curseforgeConfigured ? 'Leave blank to keep the current key' : 'Paste CurseForge API key'}
              autoComplete="off"
            />
            <button
              type="button"
              onClick={() => setShowCurseforgeKey(value => !value)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-mc-textMuted hover:text-mc-text"
              title={showCurseforgeKey ? 'Hide key' : 'Show key'}
            >
              {showCurseforgeKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          {curseforgeConfigured && (
            <button
              type="button"
              onClick={() => {
                setClearCurseforgeApiKey(true);
                setCurseforgeApiKey('');
                setCurseforgeConfigured(false);
              }}
              className="mt-3 text-xs text-mc-danger hover:underline"
            >
              Remove stored API key
            </button>
          )}
        </Section>

        <Section title="Git Catalog">
          <p className="text-sm text-mc-textMuted mb-4">
            Optional private or public Git repository of Bedrock packs. Works with GitLab, GitHub, Gitea, and other
            Git hosts. GitLab tokens must include <code className="text-mc-accent">read_repository</code>;
            {' '}<code className="text-mc-accent">read_user</code> is not enough to clone a private project.
            See <code className="text-mc-accent">docs/git-mod-catalog.md</code> for the recommended layout.
          </p>

          <div className="flex items-center justify-between p-3 bg-mc-darker rounded-lg mb-4">
            <div>
              <p className="text-sm font-medium text-white">Enable Git catalog</p>
              <p className="text-xs text-mc-textMuted">Include committed packs in catalog search</p>
            </div>
            <button
              type="button"
              onClick={() => setGitEnabled(value => !value)}
              className={`toggle ${gitEnabled ? 'toggle-active' : 'toggle-inactive'}`}
            >
              <span className={`toggle-thumb ${gitEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>

          <div className={!gitEnabled ? 'opacity-50' : ''}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-mc-text mb-2">Repository URL</label>
              <input
                type="text"
                value={gitUrl}
                onChange={(e) => setGitUrl(e.target.value)}
                className="input"
                placeholder="https://gitlab.example.com/group/bedrock-mod-catalog.git"
                disabled={!gitEnabled}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-mc-text mb-2">Branch</label>
              <input
                type="text"
                value={gitBranch}
                onChange={(e) => setGitBranch(e.target.value)}
                className="input"
                placeholder="main"
                disabled={!gitEnabled}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-mc-text mb-2">Catalog subdirectory</label>
              <input
                type="text"
                value={gitSubdir}
                onChange={(e) => setGitSubdir(e.target.value)}
                className="input"
                placeholder="Optional, e.g. mods"
                disabled={!gitEnabled}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-mc-text mb-2">Username</label>
              <input
                type="text"
                value={gitUsername}
                onChange={(e) => setGitUsername(e.target.value)}
                className="input"
                placeholder="Optional. GitLab can use oauth2"
                autoComplete="off"
                disabled={!gitEnabled}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-mc-text mb-2">Access token</label>
              <div className="relative">
                <input
                  type={showGitToken ? 'text' : 'password'}
                  value={gitToken}
                  onChange={(e) => {
                    setGitToken(e.target.value);
                    setClearGitToken(false);
                  }}
                  className="input pr-12"
                  placeholder={gitTokenSet ? 'Leave blank to keep the current token' : 'Personal access token'}
                  autoComplete="off"
                  disabled={!gitEnabled}
                />
                <button
                  type="button"
                  onClick={() => setShowGitToken(value => !value)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-mc-textMuted hover:text-mc-text"
                  title={showGitToken ? 'Hide token' : 'Show token'}
                  disabled={!gitEnabled}
                >
                  {showGitToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {gitTokenSet && (
                <button
                  type="button"
                  onClick={() => {
                    setClearGitToken(true);
                    setGitToken('');
                    setGitTokenSet(false);
                  }}
                  className="mt-2 text-xs text-mc-danger hover:underline"
                  disabled={!gitEnabled}
                >
                  Remove stored token
                </button>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 mt-4 p-3 bg-mc-darker rounded-lg">
            <GitBranch className="w-4 h-4 text-mc-textMuted" />
            <p className="text-xs text-mc-textMuted flex-1">
              {status.running
                ? 'Syncing in the background. You can leave this page; the catalog refresh icon will keep spinning until it finishes.'
                : gitLastSync
                  ? `${gitModCount} mods • last sync ${new Date(gitLastSync).toLocaleString()}`
                  : 'Not synced yet'}
            </p>
            <button type="button" onClick={handleTest} disabled={!gitEnabled || testing || !gitUrl} className="btn btn-secondary text-sm">
              {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              Test Connection
            </button>
            <button
              type="button"
              onClick={handleSync}
              disabled={syncDisabled}
              title={syncTitle}
              className="btn btn-secondary text-sm"
            >
              {status.running ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              {status.running ? 'Syncing...' : 'Sync Now'}
            </button>
          </div>
          </div>
        </Section>

        <Section title="File Catalog">
          <p className="text-sm text-mc-textMuted mb-4">
            Optional folder of Bedrock packs using the same layout as the Git catalog
            (<code className="text-mc-accent">addons/</code>, <code className="text-mc-accent">maps/</code>,
            {' '}<code className="text-mc-accent">texture-packs/</code>, plus optional <code className="text-mc-accent">catalog.json</code>).
            Enable a local folder, an SMB share, an NFS mount, or any combination. See{' '}
            <code className="text-mc-accent">docs/file-mod-catalog.md</code>.
          </p>

          <div className="flex items-center justify-between p-3 bg-mc-darker rounded-lg mb-4">
            <div>
              <p className="text-sm font-medium text-white">Enable file catalog</p>
              <p className="text-xs text-mc-textMuted">
                {fileModCount ? `${fileModCount} mods currently indexed` : 'Include packs from local or network folders'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setFileEnabled(value => !value)}
              className={`toggle ${fileEnabled ? 'toggle-active' : 'toggle-inactive'}`}
            >
              <span className={`toggle-thumb ${fileEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>

          <div className={!fileEnabled ? 'opacity-50 space-y-4' : 'space-y-4'}>
            <div className="p-3 bg-mc-darker rounded-lg space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-white">Local folder</p>
                  <p className="text-xs text-mc-textMuted">Windows or Linux path on this host. Default is the manager data catalog.</p>
                </div>
                <button
                  type="button"
                  onClick={() => setLocalEnabled(value => !value)}
                  disabled={!fileEnabled}
                  className={`toggle ${localEnabled ? 'toggle-active' : 'toggle-inactive'}`}
                >
                  <span className={`toggle-thumb ${localEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>
              <input
                type="text"
                value={localPath}
                onChange={(e) => setLocalPath(e.target.value)}
                className="input"
                placeholder={defaultLocalPath || 'data/catalog'}
                disabled={!fileEnabled || !localEnabled}
              />
              <button
                type="button"
                onClick={() => handleTestFile('local')}
                disabled={!fileEnabled || !localEnabled || testingFile === 'local'}
                className="btn btn-secondary text-sm"
              >
                {testingFile === 'local' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Folder className="w-4 h-4" />}
                Test Folder
              </button>
            </div>

            <div className="p-3 bg-mc-darker rounded-lg space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-white">SMB share</p>
                  <p className="text-xs text-mc-textMuted">UNC path such as \\server\share\catalog, or a folder where the share is already mounted.</p>
                </div>
                <button
                  type="button"
                  onClick={() => setSmbEnabled(value => !value)}
                  disabled={!fileEnabled}
                  className={`toggle ${smbEnabled ? 'toggle-active' : 'toggle-inactive'}`}
                >
                  <span className={`toggle-thumb ${smbEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>
              <input
                type="text"
                value={smbPath}
                onChange={(e) => setSmbPath(e.target.value)}
                className="input"
                placeholder="\\fileserver\bedrock\catalog"
                disabled={!fileEnabled || !smbEnabled}
              />
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <input
                  type="text"
                  value={smbUsername}
                  onChange={(e) => setSmbUsername(e.target.value)}
                  className="input"
                  placeholder="Username (optional)"
                  autoComplete="off"
                  disabled={!fileEnabled || !smbEnabled}
                />
                <div className="relative">
                  <input
                    type={showSmbPassword ? 'text' : 'password'}
                    value={smbPassword}
                    onChange={(e) => {
                      setSmbPassword(e.target.value);
                      setClearSmbPassword(false);
                    }}
                    className="input pr-12"
                    placeholder={smbPasswordSet ? 'Leave blank to keep the current password' : 'Password (optional)'}
                    autoComplete="off"
                    disabled={!fileEnabled || !smbEnabled}
                  />
                  <button
                    type="button"
                    onClick={() => setShowSmbPassword(value => !value)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-mc-textMuted hover:text-mc-text"
                    disabled={!fileEnabled || !smbEnabled}
                  >
                    {showSmbPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              {smbPasswordSet && (
                <button
                  type="button"
                  onClick={() => {
                    setClearSmbPassword(true);
                    setSmbPassword('');
                    setSmbPasswordSet(false);
                  }}
                  className="text-xs text-mc-danger hover:underline"
                  disabled={!fileEnabled || !smbEnabled}
                >
                  Remove stored SMB password
                </button>
              )}
              <button
                type="button"
                onClick={() => handleTestFile('smb')}
                disabled={!fileEnabled || !smbEnabled || !smbPath || testingFile === 'smb'}
                className="btn btn-secondary text-sm"
              >
                {testingFile === 'smb' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                Test SMB
              </button>
            </div>

            <div className="p-3 bg-mc-darker rounded-lg space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-white">NFS share</p>
                  <p className="text-xs text-mc-textMuted">Local mount path, or host:/export if this host can mount NFS.</p>
                </div>
                <button
                  type="button"
                  onClick={() => setNfsEnabled(value => !value)}
                  disabled={!fileEnabled}
                  className={`toggle ${nfsEnabled ? 'toggle-active' : 'toggle-inactive'}`}
                >
                  <span className={`toggle-thumb ${nfsEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>
              <input
                type="text"
                value={nfsPath}
                onChange={(e) => setNfsPath(e.target.value)}
                className="input"
                placeholder="/mnt/nfs/bedrock-catalog"
                disabled={!fileEnabled || !nfsEnabled}
              />
              <button
                type="button"
                onClick={() => handleTestFile('nfs')}
                disabled={!fileEnabled || !nfsEnabled || !nfsPath || testingFile === 'nfs'}
                className="btn btn-secondary text-sm"
              >
                {testingFile === 'nfs' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                Test NFS
              </button>
            </div>
          </div>
        </Section>

        <div className="flex items-center gap-3 pt-4 border-t border-mc-surfaceLight">
          <button type="submit" disabled={saving} className="btn btn-primary flex-1">
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                Save Settings
              </>
            )}
          </button>
          <button type="button" onClick={loadSettings} className="btn btn-secondary">
            <RefreshCw className="w-4 h-4" />
            Reset
          </button>
          <button type="button" onClick={() => navigate('/mods/catalog')} className="btn btn-secondary">
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="card">
      <h2 className="text-lg font-semibold text-white mb-4">{title}</h2>
      {children}
    </div>
  );
}

export default ModCatalogSettings;
