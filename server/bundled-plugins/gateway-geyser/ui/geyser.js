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
      save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
      radio: '<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49"/><path d="M7.76 16.24a6 6 0 0 1 0-8.49"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M4.93 19.07a10 10 0 0 1 0-14.14"/>',
      shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
      layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
      download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
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

  var detailNotice = { message: '', kind: '' };
  var detailDraft = null;

  function advertiseValue(gateway) {
    return gateway.advertiseInBedrockConnect === false ? 'hidden' : 'advertised';
  }

  function resetDetailDraft(gateway) {
    detailDraft = {
      id: String(gateway.id),
      authentication: gateway.authentication || 'online',
      advertise: advertiseValue(gateway),
      confirmOffline: false,
      confirmFloodgate: false,
      confirmFloodgateInstall: false,
      confirmJavaRestart: false,
      preview: null,
    };
  }

  function ensureDetailDraft(gateway) {
    if (!detailDraft || String(detailDraft.id) !== String(gateway.id)) resetDetailDraft(gateway);
  }

  function readDetailDraft() {
    if (!detailDraft) return;
    if ($('detailAuth')) detailDraft.authentication = $('detailAuth').value;
    if ($('detailAdvertise')) detailDraft.advertise = $('detailAdvertise').value;
    if ($('detailConfirmOffline')) detailDraft.confirmOffline = $('detailConfirmOffline').checked;
    if ($('detailConfirmFloodgate')) detailDraft.confirmFloodgate = $('detailConfirmFloodgate').checked;
    if ($('detailConfirmFloodgateInstall')) detailDraft.confirmFloodgateInstall = $('detailConfirmFloodgateInstall').checked;
    if ($('detailConfirmJavaRestart')) detailDraft.confirmJavaRestart = $('detailConfirmJavaRestart').checked;
  }

  function detailIsDirty(gateway) {
    if (!detailDraft) return false;
    return detailDraft.authentication !== (gateway.authentication || 'online')
      || detailDraft.advertise !== advertiseValue(gateway)
      || Boolean(detailDraft.confirmOffline)
      || Boolean(detailDraft.confirmFloodgate)
      || Boolean(detailDraft.confirmFloodgateInstall)
      || Boolean(detailDraft.confirmJavaRestart);
  }

  function syncSaveButton(gateway) {
    var saveBtn = $('detailSave');
    if (!saveBtn) return;
    saveBtn.disabled = busy === String(gateway.id) || !detailIsDirty(gateway);
  }

  function applyBanner(el, message, kind) {
    if (!el) return;
    if (!message) {
      el.classList.add('hidden');
      el.classList.remove('info');
      el.textContent = '';
      return;
    }
    el.textContent = message;
    el.classList.toggle('info', kind === 'info');
    el.classList.remove('hidden');
  }

  function formatApiError(err) {
    var data = (err && err.data) || {};
    var message = data.error || err.message || 'Request failed';
    if (data.code === 'FLOODGATE_UNSUPPORTED_TARGET') return message;
    return message;
  }

  function startBlocked(gateway) {
    return gateway
      && gateway.authentication === 'floodgate'
      && gateway.target_type === 'local-server'
      && gateway.floodgateCanStart === false
      && !isRunning(gateway);
  }

  function showError(message, kind) {
    if (selectedId && $('detailOverlay') && !$('detailOverlay').classList.contains('hidden')) {
      detailNotice = { message: message || '', kind: kind || '' };
      applyBanner($('detailNotice'), detailNotice.message, detailNotice.kind);
      return;
    }
    if ($('createOverlay') && !$('createOverlay').classList.contains('hidden') && $('createNotice')) {
      applyBanner($('createNotice'), message, kind);
      return;
    }
    applyBanner($('error'), message, kind);
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

  function askConfirm(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var existing = $('confirmOverlay');
      if (existing) existing.remove();
      var hadModal = document.body.classList.contains('modal-open');
      document.body.classList.add('modal-open');
      var overlay = document.createElement('div');
      overlay.id = 'confirmOverlay';
      overlay.className = 'overlay confirm-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-labelledby', 'confirmTitle');
      var card = document.createElement('div');
      card.className = 'overlay-card confirm-card';
      var title = document.createElement('h2');
      title.id = 'confirmTitle';
      title.textContent = opts.title || 'Confirm';
      var message = document.createElement('p');
      message.textContent = opts.message || '';
      var actions = document.createElement('div');
      actions.className = 'form-actions';
      function finish(value) {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
        if (!hadModal) document.body.classList.remove('modal-open');
        resolve(value);
      }
      function onKey(event) {
        if (event.key === 'Escape') {
          event.preventDefault();
          finish(false);
        }
      }
      var ok = makeButton(opts.confirmLabel || 'Continue', opts.danger ? 'danger' : '', function () { finish(true); });
      var cancel = makeButton('Cancel', 'secondary', function () { finish(false); });
      actions.appendChild(ok);
      actions.appendChild(cancel);
      card.appendChild(title);
      card.appendChild(message);
      card.appendChild(actions);
      overlay.appendChild(card);
      overlay.addEventListener('click', function (event) {
        if (event.target === overlay) finish(false);
      });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(overlay);
      ok.focus();
    });
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
      ? makeButton(busy === String(gateway.id) ? 'Stopping...' : 'Stop', 'danger' + (growStart ? ' grow' : ''), function () { confirmAct(gateway, 'stop'); }, 'stop')
      : makeButton(busy === String(gateway.id) ? 'Starting...' : 'Start', (growStart ? 'grow' : ''), function () { confirmAct(gateway, 'start'); }, 'play');
    startStop.disabled = disabled || startBlocked(gateway);
    if (startBlocked(gateway) && gateway.floodgateStartReason) {
      startStop.title = gateway.floodgateStartReason;
    }
    var restart = makeButton('Restart', 'outlined', function () { confirmAct(gateway, 'restart'); }, 'restart');
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
      [String(gateway.bedrock_udp_port || '—'), 'UDP port', 'radio'],
      [authLabel(gateway.authentication), 'Authentication', 'shield'],
      [modeLabel(gateway), 'Mode', 'layers'],
    ].forEach(function (row) {
      var cell = document.createElement('div');
      cell.className = 'info-cell';
      cell.innerHTML = icon(row[2]);
      cell.querySelector('svg').classList.add('info-icon');
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

  function detailField(label, content) {
    var wrap = document.createElement('div');
    var dt = document.createElement('dt');
    dt.textContent = label;
    var dd = document.createElement('dd');
    if (typeof content === 'string') dd.textContent = content;
    else dd.appendChild(content);
    wrap.appendChild(dt);
    wrap.appendChild(dd);
    return wrap;
  }

  function detailSelect(id, options, value) {
    var select = document.createElement('select');
    select.id = id;
    options.forEach(function (opt) {
      var option = document.createElement('option');
      option.value = opt.value;
      option.textContent = opt.label;
      select.appendChild(option);
    });
    select.value = value;
    select.addEventListener('change', function () {
      readDetailDraft();
      renderDetail();
      if (selectedId) showLogs(selectedId);
    });
    return select;
  }

  function detailCheck(id, checked, text) {
    var label = document.createElement('label');
    label.className = 'check';
    var input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.checked = Boolean(checked);
    input.addEventListener('change', function () {
      readDetailDraft();
      var gateway = findGateway(selectedId);
      if (gateway) syncSaveButton(gateway);
    });
    var span = document.createElement('span');
    span.textContent = text;
    label.appendChild(input);
    label.appendChild(span);
    return label;
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
    ensureDetailDraft(gateway);

    var head = document.createElement('div');
    head.className = 'detail-head';
    var left = document.createElement('div');
    left.className = 'detail-head-left';
    var titleRow = document.createElement('div');
    titleRow.className = 'detail-title-row';
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

    var right = document.createElement('div');
    right.className = 'detail-head-right';
    var close = makeButton('', 'close-btn secondary', closeDetail, 'close');
    close.setAttribute('aria-label', 'Close');
    right.appendChild(close);
    head.appendChild(left);
    head.appendChild(right);
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
    if (gateway.target_type === 'local-server') {
      var compat = document.createElement('pre');
      compat.className = 'compat-summary';
      compat.id = 'floodgateCompat';
      compat.textContent = 'Checking Floodgate compatibility…';
      root.appendChild(compat);
      loadFloodgateStatus(gateway.id, compat);
    }

    var fields = document.createElement('div');
    fields.className = 'detail-fields';
    var info = document.createElement('div');
    info.className = 'detail-info';
    info.appendChild(detailField('Bedrock UDP port', String(gateway.bedrock_udp_port || '—')));
    info.appendChild(detailField('Java target', targetLabel(gateway)));
    info.appendChild(detailField('Geyser version', gateway.geyser_version || '—'));
    info.appendChild(detailField(
      'Compatibility',
      gateway.compatibilityMode === 'viaproxy' ? 'ViaProxy' : 'Direct Geyser'
    ));
    info.appendChild(detailField('ViaProxy version', gateway.viaproxyVersion || 'not installed'));
    fields.appendChild(info);

    var dropdowns = document.createElement('div');
    dropdowns.className = 'detail-dropdowns';
    dropdowns.appendChild(detailField('Bedrock Connect', detailSelect('detailAdvertise', [
      { value: 'advertised', label: 'Advertised' },
      { value: 'hidden', label: 'Hidden' },
    ], detailDraft.advertise)));
    var authField = detailField('Authentication', detailSelect('detailAuth', [
      { value: 'online', label: 'Online (recommended)' },
      { value: 'offline', label: 'Offline (insecure)' },
      { value: 'floodgate', label: 'Floodgate' },
    ], detailDraft.authentication));
    if (detailDraft.authentication === 'online' && gateway.compatibilityMode === 'viaproxy') {
      var viaAuth = document.createElement('p');
      viaAuth.className = 'notice notice-error';
      viaAuth.textContent = 'ViaProxy cannot use online authentication. Choose Floodgate or Offline.';
      authField.appendChild(viaAuth);
    }
    dropdowns.appendChild(authField);
    fields.appendChild(dropdowns);

    var confirms = document.createElement('div');
    confirms.className = 'detail-confirms';
    if (detailDraft.authentication === 'offline' && gateway.authentication !== 'offline') {
      confirms.appendChild(detailCheck(
        'detailConfirmOffline',
        detailDraft.confirmOffline,
        'I understand offline mode disables Java authentication and must not be used on a public network.'
      ));
    }
    if (detailDraft.authentication === 'floodgate' && gateway.target_type === 'remote-address') {
      if (gateway.authentication !== 'floodgate') {
        confirms.appendChild(detailCheck(
          'detailConfirmFloodgate',
          detailDraft.confirmFloodgate,
          'The remote Java server already has Floodgate installed, and I will copy the gateway key.pem into its Floodgate folder.'
        ));
      }
    }
    if (detailDraft.authentication === 'floodgate' && gateway.target_type === 'local-server') {
      confirms.appendChild(detailCheck(
        'detailConfirmFloodgateInstall',
        detailDraft.confirmFloodgateInstall,
        'Download Floodgate onto the local Java server if it is missing, and copy the matching key.pem.'
      ));
      confirms.appendChild(detailCheck(
        'detailConfirmJavaRestart',
        detailDraft.confirmJavaRestart,
        'Restart the Java server if it is running so Floodgate can load the new key.'
      ));
    }
    if (detailDraft.preview && detailDraft.preview.missingConfirmations && detailDraft.preview.missingConfirmations.length) {
      var need = document.createElement('p');
      need.className = 'notice';
      need.textContent = 'Confirm the items above, then save again.';
      confirms.appendChild(need);
    }
    if (confirms.childNodes.length) fields.appendChild(confirms);
    root.appendChild(fields);

    var extras = document.createElement('div');
    extras.className = 'extra-actions';
    var extraSlots = [
      makeButton('Check compatibility', 'outlined', function () { checkCompat(gateway.id); }),
      gateway.compatibilityMode === 'viaproxy'
        ? makeButton('Upgrade ViaProxy', 'outlined', function () { installVia(gateway.id, running); })
        : makeButton('Install ViaProxy', 'outlined', function () { installVia(gateway.id, running); }),
      gateway.compatibilityMode === 'viaproxy'
        ? makeButton('Remove ViaProxy', 'outlined', function () { removeVia(gateway.id); })
        : null,
      gateway.authentication === 'floodgate' && gateway.target_type === 'local-server'
        ? makeButton('Install Floodgate on Java', 'outlined', function () { installFloodgate(gateway.id, running); })
        : null,
      gateway.authentication === 'floodgate' && gateway.target_type === 'remote-address'
        ? makeButton('Download Floodgate key', 'outlined', function () { downloadFloodgateKey(gateway.id); }, 'download')
        : null,
      null,
    ];
    extraSlots.forEach(function (item) {
      if (item) extras.appendChild(item);
      else {
        var slot = document.createElement('div');
        slot.className = 'slot';
        extras.appendChild(slot);
      }
    });
    root.appendChild(extras);
    if (gateway.dashboardAttachment && gateway.dashboardAttachment.primary === false) {
      var dash = makeButton('Show on dashboard tile', 'outlined', function () { setPrimary(gateway.id); });
      dash.style.marginBottom = '1rem';
      root.appendChild(dash);
    }

    var banner = document.createElement('div');
    banner.id = 'detailNotice';
    banner.className = 'error hidden';
    root.appendChild(banner);
    applyBanner(banner, detailNotice.message, detailNotice.kind);

    var consoleCard = document.createElement('div');
    consoleCard.className = 'console-card';
    var toolbar = document.createElement('div');
    toolbar.className = 'console-toolbar';
    addLifecycleButtons(toolbar, gateway, false);
    var save = makeButton(busy === String(gateway.id) ? 'Saving...' : 'Save Changes', '', function () {
      saveChanges(gateway);
    }, 'save');
    save.id = 'detailSave';
    save.disabled = busy === String(gateway.id) || !detailIsDirty(gateway);
    toolbar.appendChild(save);
    var consoleTitle = document.createElement('h2');
    consoleTitle.textContent = 'Console:';
    var logs = document.createElement('pre');
    logs.className = 'logs';
    logs.id = 'detailLogs';
    logs.textContent = 'Loading logs…';
    consoleCard.appendChild(toolbar);
    consoleCard.appendChild(consoleTitle);
    consoleCard.appendChild(logs);
    root.appendChild(consoleCard);
  }

  function openDetail(id) {
    if (String(selectedId) !== String(id)) {
      detailNotice = { message: '', kind: '' };
      detailDraft = null;
    }
    selectedId = String(id);
    renderDetail();
    setOverlay('detailOverlay', true);
    showLogs(id);
  }

  function closeDetail() {
    selectedId = '';
    detailNotice = { message: '', kind: '' };
    detailDraft = null;
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
    var ok = await askConfirm({
      title: 'Show on dashboard tile',
      message: 'Show this gateway on the Java server tile?',
      confirmLabel: 'Show on tile',
    });
    if (!ok) return;
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

  async function confirmAct(gateway, action) {
    var specs = {
      start: { title: 'Start gateway', message: 'Start "' + gateway.name + '"?', confirmLabel: 'Start' },
      stop: { title: 'Stop gateway', message: 'Stop "' + gateway.name + '"?', confirmLabel: 'Stop', danger: true },
      restart: { title: 'Restart gateway', message: 'Restart "' + gateway.name + '"?', confirmLabel: 'Restart' },
    };
    var spec = specs[action];
    if (spec && !(await askConfirm(spec))) return;
    await act(gateway.id, action);
  }

  async function removeGateway(gateway) {
    var ok = await askConfirm({
      title: 'Delete gateway',
      message: 'Delete gateway "' + gateway.name + '"? This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
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
      showError(formatApiError(err) || 'Request failed');
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

  async function loadFloodgateStatus(id, node) {
    try {
      var status = await MBM.get(API + '/gateways/' + encodeURIComponent(id) + '/floodgate/status');
      if (!node || !node.isConnected) return;
      node.textContent = (status.summary || []).join('\n');
      node.classList.toggle('compat-unsupported', Boolean(status.unsupported) || status.canStart === false);
    } catch (err) {
      if (!node || !node.isConnected) return;
      node.textContent = formatApiError(err);
      node.classList.add('compat-unsupported');
    }
  }

  async function checkCompat(id) {
    var ok = await askConfirm({
      title: 'Check compatibility',
      message: 'Check whether this Java server needs ViaProxy compatibility mode?',
      confirmLabel: 'Check',
    });
    if (!ok) return;
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
    var message = 'Download Floodgate from official sources into this Java server\'s mods or plugins folder, copy the Geyser key.pem, and restart the Java server if it is running?';
    if (running) message = 'The Java server must restart after Floodgate is installed. ' + message;
    var ok = await askConfirm({
      title: 'Install Floodgate',
      message: message,
      confirmLabel: 'Install Floodgate',
    });
    if (!ok) return;
    busy = String(id);
    showError('');
    await loadGateways();
    try {
      await MBM.post(API + '/gateways/' + encodeURIComponent(id) + '/floodgate/install', { confirm: true });
      showError('Floodgate was installed on the Java server.', 'info');
    } catch (err) {
      showError(formatApiError(err) || 'Floodgate install failed');
    } finally {
      busy = '';
      await loadGateways();
    }
  }

  async function installVia(id, running) {
    var message = 'Download ViaProxy and Geyser-ViaProxy from official sources into this gateway folder?';
    if (running) message = 'This gateway is running. It will be stopped, ViaProxy will be installed, then the gateway will start again. ' + message;
    var ok = await askConfirm({
      title: 'Install ViaProxy',
      message: message,
      confirmLabel: 'Install ViaProxy',
    });
    if (!ok) return;
    busy = String(id);
    showError('');
    await loadGateways();
    try {
      await MBM.post(API + '/gateways/' + encodeURIComponent(id) + '/viaproxy/install', {
        confirmViaProxy: true,
        confirmModeSwitch: true,
      });
      showError('ViaProxy was installed.', 'info');
    } catch (err) {
      showError(err.message || 'ViaProxy install failed');
    } finally {
      busy = '';
      await loadGateways();
    }
  }

  async function removeVia(id) {
    var ok = await askConfirm({
      title: 'Remove ViaProxy',
      message: 'Remove ViaProxy from this gateway and return to direct Geyser?',
      confirmLabel: 'Remove ViaProxy',
      danger: true,
    });
    if (!ok) return;
    busy = String(id);
    showError('');
    await loadGateways();
    try {
      await MBM.post(API + '/gateways/' + encodeURIComponent(id) + '/viaproxy/remove', { confirm: true });
      showError('ViaProxy was removed.', 'info');
    } catch (err) {
      showError(err.message || 'ViaProxy remove failed');
    } finally {
      busy = '';
      await loadGateways();
    }
  }

  async function downloadFloodgateKey(id) {
    var ok = await askConfirm({
      title: 'Download Floodgate key',
      message: 'Download this gateway\'s Floodgate key.pem? Place the same file in the remote Java Floodgate folder.',
      confirmLabel: 'Download',
    });
    if (!ok) return;
    try {
      var data = await MBM.get(API + '/gateways/' + encodeURIComponent(id) + '/floodgate/key');
      var raw = atob(data.contentBase64 || '');
      var bytes = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
      var url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
      var link = document.createElement('a');
      link.href = url;
      link.download = data.filename || 'key.pem';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      showError('Floodgate key downloaded. Place the same key.pem in the remote Java Floodgate folder.', 'info');
    } catch (err) {
      showError(err.message || 'Could not download the Floodgate key');
    }
  }

  async function saveChanges(gateway) {
    readDetailDraft();
    if (!detailIsDirty(gateway)) return;
    var checkedInstall = Boolean(detailDraft.confirmFloodgateInstall);
    var checkedJavaRestart = Boolean(detailDraft.confirmJavaRestart);
    var checkedOffline = Boolean(detailDraft.confirmOffline);
    var checkedRemoteFloodgate = Boolean(detailDraft.confirmFloodgate);
    var configChanged = detailDraft.authentication !== (gateway.authentication || 'online')
      || detailDraft.advertise !== advertiseValue(gateway);
    var ok = await askConfirm({
      title: 'Save changes',
      message: configChanged
        ? 'Save these gateway settings? The gateway will restart if it is running.'
        : 'Perform the selected actions for this gateway?',
      confirmLabel: 'Save Changes',
    });
    if (!ok) return;
    busy = String(gateway.id);
    showError('');
    var saveBtn = $('detailSave');
    if (saveBtn) saveBtn.disabled = true;
    try {
      var result = await MBM.post(API + '/gateways/' + encodeURIComponent(gateway.id) + '/apply-settings', {
        authentication: detailDraft.authentication,
        advertiseInBedrockConnect: detailDraft.advertise === 'advertised',
        confirmOffline: checkedOffline,
        confirmFloodgate: checkedRemoteFloodgate,
        confirmFloodgateInstall: checkedInstall,
        confirmJavaRestart: checkedJavaRestart,
        restartGateway: isRunning(gateway) && configChanged,
      });
      var parts = [];
      if (configChanged) parts.push('Changes have been saved.');
      if (checkedInstall || checkedJavaRestart || checkedOffline || checkedRemoteFloodgate) {
        parts.push('The selected actions have been performed.');
      }
      if (result && result.floodgateInstall && result.floodgateInstall.installed) {
        parts.push('Floodgate was installed on the Java server.');
      } else if (checkedInstall && result && result.floodgateInstall && result.floodgateInstall.alreadyPresent) {
        parts.push('Floodgate was already installed. The matching key was copied.');
      }
      if (result && result.javaRestarted) parts.push('The Java server was restarted.');
      if (result && result.gatewayRestarted) parts.push('The gateway was restarted.');
      else if (result && result.javaRestartRequired && checkedInstall && !result.javaRestarted) {
        parts.push('Restart the Java server so Floodgate can load the new key.');
      }
      if (result && result.warnings && result.warnings.length) {
        parts.push(result.warnings.join(' '));
      }
      detailNotice = { message: parts.join(' ') || 'The selected actions have been performed.', kind: 'info' };
      resetDetailDraft(result || gateway);
    } catch (err) {
      if (err.data && err.data.code === 'CONFIRMATION_REQUIRED') {
        detailDraft.preview = err.data.preview || {};
        showError(formatApiError(err) || 'This change needs confirmation');
      } else {
        showError(formatApiError(err) || 'Could not save changes');
      }
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
      if ($('confirmOverlay')) return;
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
