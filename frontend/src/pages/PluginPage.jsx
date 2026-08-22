import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { pluginApi } from '../services/api';
import { isAllowedPluginNavigatePath, proxyPluginApi } from '../services/pluginBridge';

function PluginPage() {
  const { pluginId, pageId } = useParams();
  const navigate = useNavigate();
  const iframeRef = useRef(null);
  const [plugin, setPlugin] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    pluginApi.meta(pluginId)
      .then((res) => {
        if (!cancelled) setPlugin(res.data);
      })
      .catch(() => {
        if (!cancelled) {
          setPlugin(null);
          setError('This plugin is not installed or is disabled.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pluginId]);

  const page = plugin?.pages?.find((item) => item.id === pageId)
    || (!pageId ? plugin?.pages?.[0] : null);
  const src = page ? `/api/plugins/${pluginId}/ui/${page.file}` : '';

  useEffect(() => {
    function onMessage(event) {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const msg = event.data;
      if (!msg || msg.source !== 'mbm-plugin') return;
      if (msg.type === 'navigate') {
        if (!isAllowedPluginNavigatePath(pluginId, msg.path)) return;
        navigate(msg.path);
        return;
      }
      if (msg.type !== 'api') return;
      proxyPluginApi(pluginId, msg.method, msg.path, msg.body)
        .then((data) => {
          event.source.postMessage({
            source: 'mbm-host',
            type: 'api-result',
            id: msg.id,
            ok: true,
            data,
          }, '*');
        })
        .catch((err) => {
          event.source.postMessage({
            source: 'mbm-host',
            type: 'api-result',
            id: msg.id,
            ok: false,
            status: err.status || 500,
            error: err.message,
            data: err.data,
          }, '*');
        });
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [pluginId, navigate]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-mc-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !page) {
    return (
      <div className="p-6 max-w-xl mx-auto">
        <h1 className="text-xl font-bold text-white mb-2">Plugin page not found</h1>
        <p className="text-mc-textMuted">{error || 'That plugin page does not exist.'}</p>
      </div>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      key={src}
      title={page.title || plugin.name}
      src={src}
      className="w-full h-full border-0 bg-mc-dark"
      sandbox="allow-scripts allow-forms allow-modals allow-downloads"
      referrerPolicy="no-referrer"
    />
  );
}

export default PluginPage;
