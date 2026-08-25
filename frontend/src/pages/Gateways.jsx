import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { pluginApi } from '../services/api';

function GatewaysRedirect() {
  const navigate = useNavigate();
  const [message, setMessage] = useState('Opening gateway settings…');

  useEffect(() => {
    let cancelled = false;
    pluginApi.list()
      .then((res) => {
        if (cancelled) return;
        const geyser = (res.data?.menus || []).find((item) => item.pluginId === 'gateway-geyser');
        navigate(geyser?.path || '/plugins', { replace: true });
      })
      .catch(() => {
        if (!cancelled) {
          setMessage('The Geyser gateway plugin is not available.');
          navigate('/plugins', { replace: true });
        }
      });
    return () => { cancelled = true; };
  }, [navigate]);

  return (
    <div className="p-6 text-sm text-mc-textMuted">{message}</div>
  );
}

export default GatewaysRedirect;
