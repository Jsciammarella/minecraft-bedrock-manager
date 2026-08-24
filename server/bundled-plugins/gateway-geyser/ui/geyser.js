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

  function showError(message, kind) {
    var box = $('error');
    if (!message) {
      box.classList.add('hidden');
      box.classList.remove('info');
      box.textContent = '';
      return;
    }
    box.textContent = message;
    box.classList.toggle('info', kind === 'info');
    box.classList.remove('hidden');
  }

  function stripLog(text) {
    return String(text || '')
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/\[\?[0-9;]*\$p/g, '')
      .replace(/\[c(?=\[|$)/g, '')
      .replace(/\[(?:\d{1,3}(?:;\d{1,3})*)?m/g, '');
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
    $('floodgateHint').classList.toggle('hidden', auth !== 'floodgate');
    $('floodgateWarn').classList.toggle('hidden', !(auth === 'floodgate' && remote));
    $('localFields').classList.toggle('hidden', remote);
    $('remoteFields').classList.toggle('hidden', !remote);
    $('viaproxyWarn').classList.toggle('hidden', $('compatibilityMode').value !== 'viaproxy');
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
      + ' · ' + (gateway.compatibilityMode === 'viaproxy' ? 'ViaProxy' : 'Direct Geyser')
      + (gateway.geyser_version ? ' · Geyser ' + gateway.geyser_version : '')
      + (gateway.viaproxyVersion ? ' · ViaProxy ' + gateway.viaproxyVersion : '');
    if (gateway.unresolvedTarget) {
      var unresolved = document.createElement('p');
      unresolved.className = 'notice';
      unresolved.textContent = 'This gateway target could not be resolved. Choose a Java server or remote address before starting it. It is not attached to a dashboard server tile.';
      info.appendChild(unresolved);
    }
    if (gateway.dashboardAttachment && gateway.dashboardAttachment.primary === false) {
      var extra = document.createElement('p');
      extra.className = 'notice';
      extra.textContent = 'Another Geyser gateway is shown on this Java server tile. This gateway is managed only from this page.';
      info.appendChild(extra);
    }
      var notice = document.createElement('p');
      notice.className = 'notice';
      notice.textContent = gateway.lastError;
      info.appendChild(notice);
    } else if (gateway.lastCompatibilityResult === 'viaproxy-recommended') {
      var viaNotice = document.createElement('p');
      viaNotice.className = 'notice';
      viaNotice.textContent = 'This Java server needs ViaProxy compatibility mode.';
      info.appendChild(viaNotice);
    }
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
    addBtn('Check compatibility', 'secondary', function () { checkCompat(gateway.id); });
    if (gateway.compatibilityMode === 'viaproxy') {
      addBtn('Upgrade ViaProxy', 'secondary', function () { installVia(gateway.id, running); });
      addBtn('Remove ViaProxy', 'secondary', function () { removeVia(gateway.id); });
    } else {
      addBtn('Install ViaProxy', 'secondary', function () { installVia(gateway.id, running); });
    }
    if (gateway.authentication === 'floodgate' && gateway.target_type === 'local-server') {
      addBtn('Install Floodgate on Java', 'secondary', function () { installFloodgate(gateway.id, running); });
    }
    addBtn(gateway.advertiseInBedrockConnect === false ? 'Advertise' : 'Hide from Bedrock Connect', 'secondary', function () {
      toggleAdvertise(gateway);
    });
    if (gateway.dashboardAttachment && gateway.dashboardAttachment.primary === false) {
      addBtn('Show on dashboard tile', 'secondary', function () { setPrimary(gateway.id); });
    }
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
      panel.textContent = stripLog(data.logs || 'No log output yet.');
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

  async function setPrimary(id) {
    busy = String(id);
    showError('');
    try {
      await MBM.post(API + '/gateways/' + encodeURIComponent(id) + '/dashboard-primary');
    } catch (err) {
      showError(err.message || 'Could not update the dashboard attachment');
    } finally {
      busy = '';
      await loadGateways();
    }
  }

  async function act(id, action) {
    busy = String(id);
    showError('');
    await loadGateways();
    try {
      if (action === 'remove') {
        await MBM.del(API + '/gateways/' + encodeURIComponent(id));
      } else {
        await MBM.post(API + '/gateways/' + encodeURIComponent(id) + '/' + action);
      }
    } catch (err) {
      showError(err.message || 'Request failed');
    } finally {
      busy = '';
      await loadGateways();
      if (action === 'start' || action === 'restart') {
        selectedId = String(id);
        showLogs(id);
        setTimeout(function () {
          loadGateways();
          showLogs(id);
        }, 1500);
      }
    }
  }

  async function checkCompat(id) {
    showError('');
    try {
      var result = await MBM.get(API + '/gateways/' + encodeURIComponent(id) + '/compatibility');
      var kind = result.viaProxyEnabled || result.recommendedMode === 'direct' ? 'info' : 'error';
      showError(result.message || result.recommendedMode || 'Compatibility checked', kind);
      await loadGateways();
    } catch (err) {
      showError(err.message || 'Compatibility check failed');
    }
  }

  async function installFloodgate(id, running) {
    if (running && !window.confirm('The Java server must restart after Floodgate is installed. Continue?')) return;
    if (!window.confirm('Download Floodgate from official sources into this Java server\'s mods or plugins folder, copy the Geyser key.pem, and restart the Java server if it is running?')) return;
    busy = String(id);
    showError('');
    await loadGateways();
    try {
      await MBM.post(API + '/gateways/' + encodeURIComponent(id) + '/floodgate/install', { confirm: true });
    } catch (err) {
      showError(err.message || 'Floodgate install failed');
    } finally {
      busy = '';
      await loadGateways();
    }
  }

  async function installVia(id, running) {
    if (running && !window.confirm('This gateway is running. Stop it, install ViaProxy, then start it again?')) return;
    if (!window.confirm('Download ViaProxy and Geyser-ViaProxy from official sources into this gateway folder?')) return;
    busy = String(id);
    showError('');
    await loadGateways();
    try {
      await MBM.post(API + '/gateways/' + encodeURIComponent(id) + '/viaproxy/install', {
        confirmViaProxy: true,
        confirmModeSwitch: true,
      });
    } catch (err) {
      showError(err.message || 'ViaProxy install failed');
    } finally {
      busy = '';
      await loadGateways();
    }
  }

  async function removeVia(id) {
    if (!window.confirm('Remove ViaProxy from this gateway and return to direct Geyser?')) return;
    busy = String(id);
    showError('');
    await loadGateways();
    try {
      await MBM.post(API + '/gateways/' + encodeURIComponent(id) + '/viaproxy/remove', { confirm: true });
    } catch (err) {
      showError(err.message || 'ViaProxy remove failed');
    } finally {
      busy = '';
      await loadGateways();
    }
  }

  async function toggleAdvertise(gateway) {
    busy = String(gateway.id);
    showError('');
    await loadGateways();
    try {
      await MBM.patch(API + '/gateways/' + encodeURIComponent(gateway.id), {
        advertiseInBedrockConnect: gateway.advertiseInBedrockConnect === false,
      });
    } catch (err) {
      showError(err.message || 'Could not update advertisement');
    } finally {
      busy = '';
      await loadGateways();
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
      advertiseInBedrockConnect: $('advertiseInBedrockConnect').checked,
    };
    if (targetType === 'local-server') {
      body.targetServerId = Number($('targetServerId').value);
    } else {
      body.targetHost = $('targetHost').value.trim();
      body.targetTcpPort = Number($('targetTcpPort').value);
    }
    if ($('bedrockUdpPort').value) body.bedrockUdpPort = Number($('bedrockUdpPort').value);
    var wantVia = $('compatibilityMode').value === 'viaproxy';
    if (wantVia && !$('confirmViaProxy').checked) {
      showError('ViaProxy is not installed unless you confirm that choice.');
      return;
    }
    $('createBtn').disabled = true;
    try {
      var created = await MBM.post(API + '/gateways', body);
      if (wantVia && created && created.id) {
        await MBM.post(API + '/gateways/' + encodeURIComponent(created.id) + '/viaproxy/install', {
          confirmViaProxy: true,
          confirmModeSwitch: true,
        });
      }
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
    $('compatibilityMode').addEventListener('change', toggleAuthHints);
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
