(function () {
  var API = '/api/plugins/gateway-geyser';
  var busy = '';
  var selectedId = '';
  var logTimer = null;
  var gatewaysCache = [];

  function $(id) { return document.getElementById(id); }

  function icon(name) {
    var paths = {
      play: '<polygon points="5 3 19 12 5 21 5 3" fill="currentColor" stroke="none"/>',
      stop: '<rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none"/>',
      restart: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
      trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
      close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    };
    return '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (paths[name] || '') + '</svg>';
  }

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

  function isRunning(gateway) {
    return gateway.status === 'running' || gateway.status === 'starting';
  }

  function statusClass(status) {
    if (status === 'running') return 'badge-success';
    if (status === 'starting') return 'badge-warning';
    return 'badge-muted';
  }

  function dotClass(status) {
    if (status === 'running') return 'dot-running';
    if (status === 'starting') return 'dot-starting';
    return 'dot-stopped';
  }

  function authLabel(value) {
    if (value === 'floodgate') return 'Floodgate';
    if (value === 'offline') return 'Offline';
    return 'Online';
  }

  function modeLabel(gateway) {
    return gateway.compatibilityMode === 'viaproxy' ? 'ViaProxy' : 'Direct';
  }

  function targetLabel(gateway) {
    return (gateway.target_host || 'Java') + ':' + gateway.target_tcp_port;
  }

  function setOverlay(id, open) {
    var node = $(id);
    if (!node) return;
    node.classList.toggle('hidden', !open);
    var anyOpen = !$('createOverlay').classList.contains('hidden')
      || !$('detailOverlay').classList.contains('hidden');
    document.body.classList.toggle('modal-open', anyOpen);
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

  function makeButton(label, cls, onClick, glyph) {
    var btn = document.createElement('button');
    btn.type = 'button';
    if (cls) btn.className = cls;
    if (glyph) btn.innerHTML = icon(glyph) + '<span></span>';
    if (glyph) btn.querySelector('span').textContent = label;
    else btn.textContent = label;
    btn.addEventListener('click', function (event) {
      event.stopPropagation();
      onClick(event);
    });
    return btn;
  }

  function addLifecycleButtons(target, gateway, growStart) {
    var running = isRunning(gateway);
    var disabled = busy === String(gateway.id);
    var startStop = running
      ? makeButton(busy === String(gateway.id) ? 'Stopping...' : 'Stop', 'danger' + (growStart ? ' grow' : ''), function () { act(gateway.id, 'stop'); }, 'stop')
      : makeButton(busy === String(gateway.id) ? 'Starting...' : 'Start', (growStart ? 'grow' : ''), function () { act(gateway.id, 'start'); }, 'play');
    startStop.disabled = disabled;
    var restart = makeButton('Restart', 'secondary', function () { act(gateway.id, 'restart'); }, 'restart');
    restart.disabled = disabled;
    var remove = makeButton('Delete', 'secondary danger', function () { removeGateway(gateway); }, 'trash');
    remove.title = 'Delete gateway';
    remove.setAttribute('aria-label', 'Delete gateway');
    remove.disabled = disabled;
    target.appendChild(startStop);
    target.appendChild(restart);
    target.appendChild(remove);
  }

  function renderStats(gateways) {
    var running = gateways.filter(function (item) { return item.status === 'running'; }).length;
    var starting = gateways.filter(function (item) { return item.status === 'starting'; }).length;
    var stopped = gateways.length - running - starting;
    $('stats').innerHTML = '';
    [
      ['Gateways', String(gateways.length)],
      ['Running', String(running + starting)],
      ['Stopped', String(stopped)],
    ].forEach(function (row) {
      var card = document.createElement('div');
      card.className = 'stat';
      var label = document.createElement('div');
      label.className = 'label';
      label.textContent = row[0];
      var value = document.createElement('div');
      value.className = 'value';
      value.textContent = row[1];
      card.appendChild(label);
      card.appendChild(value);
      $('stats').appendChild(card);
    });
  }

  function renderGateway(gateway) {
    var tile = document.createElement('div');
    tile.className = 'tile';
    tile.id = 'gw-' + gateway.id;
    tile.tabIndex = 0;
    tile.setAttribute('role', 'button');
    tile.setAttribute('aria-label', 'View ' + gateway.name + ' details');
    tile.addEventListener('click', function () { openDetail(gateway.id); });
    tile.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openDetail(gateway.id);
      }
    });

    var header = document.createElement('div');
    header.className = 'tile-header';
    var titleWrap = document.createElement('div');
    titleWrap.className = 'tile-title';
    var dot = document.createElement('span');
    dot.className = 'dot ' + dotClass(gateway.status);
    var names = document.createElement('div');
    var heading = document.createElement('h3');
    heading.textContent = gateway.name;
    var chips = document.createElement('div');
    chips.style.display = 'flex';
    chips.style.flexWrap = 'wrap';
    chips.style.gap = '0.35rem';
    chips.style.marginTop = '0.35rem';
    function chip(text, cls) {
      var node = document.createElement('span');
      node.className = 'chip ' + cls;
      node.textContent = text;
      chips.appendChild(node);
    }
    chip('Geyser', 'chip-geyser');
    if (gateway.compatibilityMode === 'viaproxy') chip('ViaProxy', 'chip-via');
    if (gateway.authentication === 'floodgate') chip('Floodgate', 'chip-floodgate');
    if (gateway.target_type === 'remote-address') chip('Remote', 'chip-remote');
    var subtitle = document.createElement('p');
    subtitle.className = 'meta';
    subtitle.textContent = 'UDP ' + gateway.bedrock_udp_port + ' → ' + targetLabel(gateway);
    names.appendChild(heading);
    names.appendChild(chips);
    names.appendChild(subtitle);
    titleWrap.appendChild(dot);
    titleWrap.appendChild(names);
    var badge = document.createElement('span');
    badge.className = 'badge ' + statusClass(gateway.status);
    badge.textContent = gateway.status || 'stopped';
    header.appendChild(titleWrap);
    header.appendChild(badge);
    tile.appendChild(header);

    if (gateway.lastError) {
      var err = document.createElement('p');
      err.className = 'notice notice-error';
      err.textContent = gateway.lastError;
      tile.appendChild(err);
    }

    var info = document.createElement('div');
    info.className = 'info-grid';
    [
      [String(gateway.bedrock_udp_port || '—'), 'UDP port'],
      [authLabel(gateway.authentication), 'Auth'],
      [modeLabel(gateway), 'Mode'],
    ].forEach(function (row) {
      var cell = document.createElement('div');
      cell.className = 'info-cell';
      var value = document.createElement('p');
      value.className = 'value';
      value.textContent = row[0];
      var label = document.createElement('p');
      label.className = 'label';
      label.textContent = row[1];
      cell.appendChild(value);
      cell.appendChild(label);
      info.appendChild(cell);
    });
    tile.appendChild(info);

    var actions = document.createElement('div');
    actions.className = 'tile-actions';
    addLifecycleButtons(actions, gateway, true);
    tile.appendChild(actions);
    return tile;
  }

  function findGateway(id) {
    return gatewaysCache.find(function (item) { return String(item.id) === String(id); }) || null;
  }

  function renderDetail() {
    var gateway = findGateway(selectedId);
    var root = $('detail');
    root.innerHTML = '';
    if (!gateway) {
      setOverlay('detailOverlay', false);
      selectedId = '';
      return;
    }
    var running = isRunning(gateway);

    var head = document.createElement('div');
    head.className = 'detail-head';
    var left = document.createElement('div');
    var titleRow = document.createElement('div');
    titleRow.style.display = 'flex';
    titleRow.style.alignItems = 'center';
    titleRow.style.flexWrap = 'wrap';
    titleRow.style.gap = '0.5rem';
    var title = document.createElement('h1');
    title.id = 'detailTitle';
    title.textContent = gateway.name;
    var badge = document.createElement('span');
    badge.className = 'badge ' + statusClass(gateway.status);
    badge.textContent = gateway.status || 'stopped';
    titleRow.appendChild(title);
    titleRow.appendChild(badge);
    var sub = document.createElement('p');
    sub.className = 'meta';
    sub.textContent = 'UDP ' + gateway.bedrock_udp_port + ' → ' + targetLabel(gateway)
      + (gateway.geyser_version ? ' · Geyser ' + gateway.geyser_version : '')
      + (gateway.viaproxyVersion ? ' · ViaProxy ' + gateway.viaproxyVersion : '');
    left.appendChild(titleRow);
    left.appendChild(sub);
    var close = makeButton('', 'close-btn secondary', closeDetail, 'close');
    close.setAttribute('aria-label', 'Close');
    head.appendChild(left);
    head.appendChild(close);
    root.appendChild(head);

    if (gateway.unresolvedTarget) {
      var unresolved = document.createElement('p');
      unresolved.className = 'notice notice-error';
      unresolved.textContent = 'This gateway target could not be resolved. Choose a Java server or remote address before starting it.';
      root.appendChild(unresolved);
    }
    if (gateway.dashboardAttachment && gateway.dashboardAttachment.primary === false) {
      var extra = document.createElement('p');
      extra.className = 'notice';
      extra.textContent = 'Another Geyser gateway is shown on this Java server tile. This gateway is managed only from this page.';
      root.appendChild(extra);
    }
    if (gateway.lastError) {
      var notice = document.createElement('p');
      notice.className = 'notice notice-error';
      notice.textContent = gateway.lastError;
      root.appendChild(notice);
    } else if (gateway.lastCompatibilityResult === 'viaproxy-recommended') {
      var viaNotice = document.createElement('p');
      viaNotice.className = 'notice';
      viaNotice.textContent = 'This Java server needs ViaProxy compatibility mode.';
      root.appendChild(viaNotice);
    }

    var actions = document.createElement('div');
    actions.className = 'page-actions';
    addLifecycleButtons(actions, gateway, false);
    root.appendChild(actions);

    var dl = document.createElement('dl');
    dl.className = 'detail-dl';
    [
      ['Bedrock UDP port', String(gateway.bedrock_udp_port || '—')],
      ['Java target', targetLabel(gateway)],
      ['Authentication', authLabel(gateway.authentication)],
      ['Compatibility', gateway.compatibilityMode === 'viaproxy' ? 'ViaProxy' : 'Direct Geyser'],
      ['Geyser version', gateway.geyser_version || '—'],
      ['ViaProxy version', gateway.viaproxyVersion || 'not installed'],
      ['Bedrock Connect', gateway.advertiseInBedrockConnect === false ? 'Hidden' : 'Advertised'],
    ].forEach(function (row) {
      var dt = document.createElement('dt');
      dt.textContent = row[0];
      var wrap = document.createElement('div');
      var dd = document.createElement('dd');
      dd.textContent = row[1];
      wrap.appendChild(dt);
      wrap.appendChild(dd);
      dl.appendChild(wrap);
    });
    root.appendChild(dl);

    var extras = document.createElement('div');
    extras.className = 'extra-actions';
    extras.appendChild(makeButton('Check compatibility', 'secondary', function () { checkCompat(gateway.id); }));
    if (gateway.compatibilityMode === 'viaproxy') {
      extras.appendChild(makeButton('Upgrade ViaProxy', 'secondary', function () { installVia(gateway.id, running); }));
      extras.appendChild(makeButton('Remove ViaProxy', 'secondary', function () { removeVia(gateway.id); }));
    } else {
      extras.appendChild(makeButton('Install ViaProxy', 'secondary', function () { installVia(gateway.id, running); }));
    }
    if (gateway.authentication === 'floodgate' && gateway.target_type === 'local-server') {
      extras.appendChild(makeButton('Install Floodgate on Java', 'secondary', function () { installFloodgate(gateway.id, running); }));
    }
    extras.appendChild(makeButton(
      gateway.advertiseInBedrockConnect === false ? 'Advertise in Bedrock Connect' : 'Hide from Bedrock Connect',
      'secondary',
      function () { toggleAdvertise(gateway); }
    ));
    if (gateway.dashboardAttachment && gateway.dashboardAttachment.primary === false) {
      extras.appendChild(makeButton('Show on dashboard tile', 'secondary', function () { setPrimary(gateway.id); }));
    }
    root.appendChild(extras);

    var consoleCard = document.createElement('div');
    var consoleTitle = document.createElement('h2');
    consoleTitle.textContent = 'Console';
    var logs = document.createElement('pre');
    logs.className = 'logs';
    logs.id = 'detailLogs';
    logs.textContent = 'Loading logs…';
    consoleCard.appendChild(consoleTitle);
    consoleCard.appendChild(logs);
    root.appendChild(consoleCard);
  }

  function openDetail(id) {
    selectedId = String(id);
    renderDetail();
    setOverlay('detailOverlay', true);
    showLogs(id);
  }

  function closeDetail() {
    selectedId = '';
    setOverlay('detailOverlay', false);
  }

  function openCreate() {
    setOverlay('createOverlay', true);
    if ($('name')) $('name').focus();
  }

  function closeCreate() {
    setOverlay('createOverlay', false);
  }

  async function loadGateways() {
    var list = $('list');
    var data = await MBM.get(API + '/gateways');
    gatewaysCache = data.gateways || [];
    renderStats(gatewaysCache);
    list.innerHTML = '';
    if (!gatewaysCache.length) {
      var empty = document.createElement('div');
      empty.className = 'card empty';
      var heading = document.createElement('h3');
      heading.textContent = 'No gateways yet';
      var text = document.createElement('p');
      text.textContent = 'Create a standalone Geyser gateway to let Bedrock clients join a local or remote Java server.';
      empty.appendChild(heading);
      empty.appendChild(text);
      list.appendChild(empty);
    } else {
      gatewaysCache.forEach(function (gateway) {
        list.appendChild(renderGateway(gateway));
      });
    }
    if (selectedId && findGateway(selectedId)) {
      renderDetail();
      await showLogs(selectedId);
    } else if (selectedId) {
      closeDetail();
    }
    return gatewaysCache;
  }

  async function showLogs(id) {
    var panel = $('detailLogs');
    if (!panel || String(id) !== String(selectedId)) return;
    try {
      var data = await MBM.get(API + '/gateways/' + encodeURIComponent(id) + '/logs');
      panel.textContent = stripLog(data.logs || 'No log output yet.');
    } catch (err) {
      panel.textContent = err.message || 'Could not load logs.';
    }
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

  async function removeGateway(gateway) {
    if (!window.confirm('Delete gateway "' + gateway.name + '"? This cannot be undone.')) return;
    await act(gateway.id, 'remove');
  }

  async function act(id, action) {
    busy = String(id);
    showError('');
    await loadGateways();
    try {
      if (action === 'remove') {
        await MBM.del(API + '/gateways/' + encodeURIComponent(id));
        if (String(selectedId) === String(id)) closeDetail();
      } else {
        await MBM.post(API + '/gateways/' + encodeURIComponent(id) + '/' + action);
      }
    } catch (err) {
      showError(err.message || 'Request failed');
    } finally {
      busy = '';
      await loadGateways();
      if ((action === 'start' || action === 'restart') && String(selectedId) === String(id)) {
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
      closeCreate();
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
    $('add').addEventListener('click', openCreate);
    $('cancel').addEventListener('click', closeCreate);
    $('createOverlay').addEventListener('click', function (event) {
      if (event.target === $('createOverlay')) closeCreate();
    });
    $('detailOverlay').addEventListener('click', function (event) {
      if (event.target === $('detailOverlay')) closeDetail();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      if (!$('detailOverlay').classList.contains('hidden')) closeDetail();
      else if (!$('createOverlay').classList.contains('hidden')) closeCreate();
    });
    $('targetType').addEventListener('change', toggleAuthHints);
    $('authentication').addEventListener('change', toggleAuthHints);
    $('compatibilityMode').addEventListener('change', toggleAuthHints);
    $('create').addEventListener('submit', createGateway);
    toggleAuthHints();
    try {
      var servers = await loadTargets();
      if (queryNumber('targetServerId') && servers.length) {
        openCreate();
        $('targetType').value = 'local-server';
        toggleAuthHints();
      }
      await loadGateways();
      var wanted = queryNumber('gatewayId');
      if (wanted && findGateway(wanted)) openDetail(wanted);
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
