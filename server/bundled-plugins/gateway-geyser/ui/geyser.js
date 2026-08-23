(function () {
  var API = '/api/plugins/gateway-geyser';
  var busy = '';
  var selectedId = '';
  var logTimer = null;

  function $(id) { return document.getElementById(id); }

  function applyTheme() {
    if (!window.MBM || !MBM.theme) return;
    var t = MBM.theme;
    var root = document.documentElement.style;
    if (t.dark) root.setProperty('--bg', t.dark);
    if (t.darker) root.setProperty('--darker', t.darker);
    if (t.accent) root.setProperty('--accent', t.accent);
    if (t.accentHover) root.setProperty('--accent-hover', t.accentHover);
    if (t.danger) root.setProperty('--danger', t.danger);
    if (t.warning) root.setProperty('--warning', t.warning);
    if (t.surface) root.setProperty('--surface', t.surface);
    if (t.surfaceLight) root.setProperty('--line', t.surfaceLight);
    if (t.text) root.setProperty('--text', t.text);
    if (t.textMuted) root.setProperty('--muted', t.textMuted);
  }

  function showError(message) {
    var box = $('error');
    if (!message) {
      box.classList.add('hidden');
      box.textContent = '';
      return;
    }
    box.textContent = message;
    box.classList.remove('hidden');
  }

  function params() {
    return new URLSearchParams(location.search || '');
  }

  function queryNumber(name) {
    var value = params().get(name);
    if (!value) return '';
    var num = Number(value);
    return Number.isInteger(num) && num > 0 ? String(num) : '';
  }

  function toggleAuthHints() {
    var auth = $('authentication').value;
    var remote = $('targetType').value === 'remote-address';
    $('offlineWarn').classList.toggle('hidden', auth !== 'offline');
    $('floodgateWarn').classList.toggle('hidden', !(auth === 'floodgate' && remote));
    $('localFields').classList.toggle('hidden', remote);
    $('remoteFields').classList.toggle('hidden', !remote);
  }

  async function loadTargets() {
    var select = $('targetServerId');
    var current = select.value || queryNumber('targetServerId');
    var data = await MBM.get(API + '/java-targets');
    var servers = data.servers || [];
    select.innerHTML = '<option value="">Select a Java server</option>';
    servers.forEach(function (server) {
      var option = document.createElement('option');
      option.value = String(server.id);
      option.textContent = server.name + ' (TCP ' + server.port + ')';
      select.appendChild(option);
    });
    if (current && servers.some(function (server) { return String(server.id) === current; })) {
      select.value = current;
    }
    return servers;
  }

  function renderGateway(gateway) {
    var card = document.createElement('div');
    card.className = 'card';
    card.id = 'gw-' + gateway.id;
    var running = gateway.status === 'running' || gateway.status === 'starting';
    card.innerHTML = '';
    var top = document.createElement('div');
    top.className = 'row';
    var info = document.createElement('div');
    var title = document.createElement('div');
    title.innerHTML = '<strong></strong> <span class="status"></span>';
    title.querySelector('strong').textContent = gateway.name;
    title.querySelector('.status').textContent = gateway.status || 'stopped';
    var meta = document.createElement('p');
    meta.className = 'meta';
    meta.textContent = 'Bedrock UDP ' + gateway.bedrock_udp_port
      + ' → ' + gateway.target_host + ':' + gateway.target_tcp_port
      + ' (' + gateway.authentication + ')'
      + (gateway.geyser_version ? ' · Geyser ' + gateway.geyser_version : '');
    info.appendChild(title);
    info.appendChild(meta);
    var actions = document.createElement('div');
    actions.className = 'actions';
    function addBtn(label, cls, fn) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      if (cls) btn.className = cls;
      btn.disabled = busy === String(gateway.id);
      btn.addEventListener('click', fn);
      actions.appendChild(btn);
    }
    if (running) addBtn('Stop', 'secondary', function () { act(gateway.id, 'stop'); });
    else addBtn('Start', '', function () { act(gateway.id, 'start'); });
    addBtn('Restart', 'secondary', function () { act(gateway.id, 'restart'); });
    addBtn('Logs', 'secondary', function () { toggleLogs(gateway.id); });
    addBtn('Remove', 'secondary', function () { act(gateway.id, 'remove'); });
    top.appendChild(info);
    top.appendChild(actions);
    card.appendChild(top);
    var logs = document.createElement('pre');
    logs.className = 'logs hidden';
    logs.id = 'logs-' + gateway.id;
    card.appendChild(logs);
    return card;
  }

  async function loadGateways() {
    var list = $('list');
    var data = await MBM.get(API + '/gateways');
    var gateways = data.gateways || [];
    list.innerHTML = '';
    if (!gateways.length) {
      var empty = document.createElement('div');
      empty.className = 'card';
      empty.textContent = 'No Geyser gateways yet. Standalone can target a local Java server on this manager or a remote Java host.';
      list.appendChild(empty);
      return gateways;
    }
    gateways.forEach(function (gateway) {
      list.appendChild(renderGateway(gateway));
    });
    var wanted = selectedId || queryNumber('gatewayId');
    if (wanted && gateways.some(function (item) { return String(item.id) === String(wanted); })) {
      selectedId = String(wanted);
      await showLogs(selectedId);
    }
    return gateways;
  }

  async function showLogs(id) {
    selectedId = String(id);
    document.querySelectorAll('.logs').forEach(function (node) {
      node.classList.toggle('hidden', node.id !== 'logs-' + id);
    });
    var panel = $('logs-' + id);
    if (!panel) return;
    try {
      var data = await MBM.get(API + '/gateways/' + encodeURIComponent(id) + '/logs');
      panel.textContent = data.logs || 'No log output yet.';
    } catch (err) {
      panel.textContent = err.message || 'Could not load logs.';
    }
  }

  function toggleLogs(id) {
    if (selectedId === String(id)) {
      selectedId = '';
      var panel = $('logs-' + id);
      if (panel) panel.classList.add('hidden');
      return;
    }
    showLogs(id);
  }

  async function act(id, action) {
    busy = String(id);
    showError('');
    try {
      if (action === 'remove') {
        await MBM.del(API + '/gateways/' + encodeURIComponent(id));
      } else {
        await MBM.post(API + '/gateways/' + encodeURIComponent(id) + '/' + action);
      }
      await loadGateways();
    } catch (err) {
      showError(err.message || 'Request failed');
    } finally {
      busy = '';
    }
  }

  async function createGateway(event) {
    event.preventDefault();
    showError('');
    var targetType = $('targetType').value;
    var auth = $('authentication').value;
    var body = {
      name: $('name').value.trim(),
      providerId: 'geyser',
      targetType: targetType,
      authentication: auth,
      confirmOffline: $('confirmOffline').checked,
      confirmFloodgate: $('confirmFloodgate').checked,
    };
    if (targetType === 'local-server') {
      body.targetServerId = Number($('targetServerId').value);
    } else {
      body.targetHost = $('targetHost').value.trim();
      body.targetTcpPort = Number($('targetTcpPort').value);
    }
    if ($('bedrockUdpPort').value) body.bedrockUdpPort = Number($('bedrockUdpPort').value);
    $('createBtn').disabled = true;
    try {
      await MBM.post(API + '/gateways', body);
      $('create').classList.add('hidden');
      $('create').reset();
      toggleAuthHints();
      await loadGateways();
    } catch (err) {
      showError(err.message || 'Could not create the gateway');
    } finally {
      $('createBtn').disabled = false;
    }
  }

  async function boot() {
    applyTheme();
    $('add').addEventListener('click', function () {
      $('create').classList.remove('hidden');
    });
    $('cancel').addEventListener('click', function () {
      $('create').classList.add('hidden');
    });
    $('targetType').addEventListener('change', toggleAuthHints);
    $('authentication').addEventListener('change', toggleAuthHints);
    $('create').addEventListener('submit', createGateway);
    toggleAuthHints();
    try {
      var servers = await loadTargets();
      if (queryNumber('targetServerId') && servers.length) {
        $('create').classList.remove('hidden');
        $('targetType').value = 'local-server';
        toggleAuthHints();
      }
      await loadGateways();
    } catch (err) {
      showError(err.message || 'Could not load Geyser gateways.');
    }
    logTimer = setInterval(function () {
      if (selectedId) showLogs(selectedId);
    }, 2500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
