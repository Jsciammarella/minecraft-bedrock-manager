(function (global) {
  if (global.MBM) return;

  var pending = Object.create(null);
  var seq = 0;
  var timeoutMs = 120000;

  function pluginIdFromLocation() {
    try {
      var parts = String(location.pathname || '').split('/');
      var idx = parts.indexOf('plugins');
      if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
    } catch (err) { /* ignore */ }
    return '';
  }

  global.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || msg.source !== 'mbm-host') return;
    var waiter = pending[msg.id];
    if (!waiter) return;
    delete pending[msg.id];
    global.clearTimeout(waiter.timer);
    if (msg.ok) waiter.resolve(msg.data);
    else {
      var error = new Error(msg.error || 'Plugin API request failed');
      error.status = msg.status;
      error.data = msg.data;
      waiter.reject(error);
    }
  });

  function request(method, apiPath, body) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      var timer = global.setTimeout(function () {
        delete pending[id];
        reject(new Error('Plugin API timeout'));
      }, timeoutMs);
      pending[id] = { resolve: resolve, reject: reject, timer: timer };
      parent.postMessage({
        source: 'mbm-plugin',
        type: 'api',
        id: id,
        method: String(method || 'GET').toUpperCase(),
        path: apiPath,
        body: body
      }, '*');
    });
  }

  global.MBM = {
    pluginId: pluginIdFromLocation(),
    theme: {
      dark: '#1a1a2e',
      darker: '#16162a',
      accent: '#4ade80',
      accentHover: '#22c55e',
      danger: '#ef4444',
      warning: '#f59e0b',
      info: '#3b82f6',
      surface: '#252545',
      surfaceLight: '#2d2d50',
      text: '#e2e8f0',
      textMuted: '#94a3b8'
    },
    get: function (apiPath) { return request('GET', apiPath); },
    post: function (apiPath, body) { return request('POST', apiPath, body); },
    put: function (apiPath, body) { return request('PUT', apiPath, body); },
    patch: function (apiPath, body) { return request('PATCH', apiPath, body); },
    del: function (apiPath) { return request('DELETE', apiPath); },
    request: request,
    navigate: function (appPath) {
      parent.postMessage({
        source: 'mbm-plugin',
        type: 'navigate',
        path: appPath
      }, '*');
    }
  };
})(window);
