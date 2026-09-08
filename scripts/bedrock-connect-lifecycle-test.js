const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const processControl = require('../server/services/processControl');
const lifecycle = require('../server/services/bedrockConnectLifecycle');
const list = require('../server/services/bedrockConnectList');
const logger = require('../server/services/logger');

class FakePty extends EventEmitter {
  constructor({ pid, killNoExit = false, exitDelayMs = 0 } = {}) {
    super();
    this.pid = pid;
    this.killNoExit = killNoExit;
    this.exitDelayMs = exitDelayMs;
    this.killCalls = 0;
    this.killed = false;
  }

  write() {}

  kill() {
    this.killCalls += 1;
    this.killed = true;
    if (this.killNoExit) return;
    setTimeout(() => this.emit('exit', 0), this.exitDelayMs);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(fn, timeoutMs = 2000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(15);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function insertServer(db, { name, port, dataPath, kind = 'bedrock', status = 'stopped' }) {
  return db.prepare(`
    INSERT INTO servers (name, version, port, data_path, kind, status)
    VALUES (?, 'test', ?, ?, ?, ?)
  `).run(name, port, dataPath, kind, status).lastInsertRowid;
}

function ensureBedrockConnect(db, serverManager, testRoot) {
  const existing = serverManager.getBedrockConnectServer();
  if (existing) return existing;
  const dataPath = path.join(testRoot, 'bc-lifecycle');
  fs.mkdirSync(dataPath, { recursive: true });
  const id = insertServer(db, {
    name: 'Bedrock Connect',
    port: 19132,
    dataPath,
    kind: 'bedrock_connect',
  });
  serverManager.invalidateServerCache(id);
  return serverManager.getBedrockConnectServer();
}

function runProcessControlTests() {
  const alive = new Set([50, 60, 70]);
  const kills = [];
  processControl.reset();
  processControl.configure({
    platform: 'linux',
    kill(pid, signal) {
      kills.push({ pid, signal });
      if (signal === 0) {
        if (!alive.has(pid)) {
          const err = new Error('ESRCH');
          err.code = 'ESRCH';
          throw err;
        }
        return;
      }
      if (signal === 'SIGKILL') alive.delete(pid);
    },
    readFileSync() { throw new Error('no-proc'); },
    readdirSync() { return []; },
    execFile: async () => { throw new Error('execFile should not run on linux terminate'); },
  });

  return processControl.terminateProcessTree({
    pid: 50,
    verify: false,
    gracefulMs: 30,
    forceMs: 30,
  }).then((result) => {
    assert.equal(result.ok, true);
    assert.equal(result.method, 'forced');
    assert.ok(kills.some((item) => item.pid === 50 && item.signal === 'SIGTERM'));
    assert.ok(kills.some((item) => item.pid === 50 && item.signal === 'SIGKILL'));
    assert.equal(kills.some((item) => item.pid === 60 || item.pid === 70), false);
    assert.equal(kills.some((item) => /java/i.test(String(item.signal))), false);
    assert.ok(!alive.has(50));
    assert.ok(alive.has(60));
    assert.ok(alive.has(70));
  }).then(async () => {
    const commands = [];
    const winAlive = new Set([80]);
    processControl.reset();
    processControl.configure({
      platform: 'win32',
      kill(pid, signal) {
        if (signal === 0) {
          if (!winAlive.has(pid)) {
            const err = new Error('ESRCH');
            err.code = 'ESRCH';
            throw err;
          }
        }
      },
      execFile: async (file, args) => {
        commands.push({ file, args: [...args] });
        assert.equal(/java\.exe/i.test(String(file)), false);
        assert.equal(args.includes('java.exe'), false);
        assert.equal(args.includes('/IM'), false);
        if (String(file).toLowerCase().includes('taskkill') && args.includes('/F')) {
          const idx = args.indexOf('/PID');
          winAlive.delete(Number(args[idx + 1]));
        }
        return { stdout: '' };
      },
    });
    const win = await processControl.terminateProcessTree({
      pid: 80,
      verify: false,
      gracefulMs: 20,
      forceMs: 20,
    });
    assert.equal(win.ok, true);
    assert.ok(commands.some((item) => item.args.includes('/PID') && item.args.includes('80') && item.args.includes('/T')));
    assert.ok(commands.some((item) => item.args.includes('/F')));
    assert.equal(commands.some((item) => item.args.includes('java.exe') || item.args.includes('/IM')), false);

    const inodes = processControl.parseProcNetInodes(
      '  sl  local_address rem_address  st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
      + '   1: 00000000:4ABC 00000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 11111\n',
      19132
    );
    assert.ok(inodes.has('11111'));
    const netstat = processControl.parseWindowsNetstatPids(
      '  UDP    0.0.0.0:19132          *:*                                    4321\n',
      19132
    );
    assert.deepEqual(netstat, [4321]);
    processControl.reset();
  });
}

async function runBedrockConnectLifecycleTests({ testRoot, db, serverManager }) {
  await runProcessControlTests();

  const bc = ensureBedrockConnect(db, serverManager, testRoot);
  const dataPath = bc.data_path;
  fs.mkdirSync(dataPath, { recursive: true });
  const jarPath = path.join(dataPath, 'BedrockConnect-1.0-SNAPSHOT.jar');
  fs.writeFileSync(jarPath, 'fake-jar');
  db.prepare("UPDATE servers SET status = 'stopped', pid = NULL, pending_restart_reason = NULL WHERE id = ?").run(bc.id);
  serverManager.invalidateServerCache(bc.id);
  lifecycle.resetForTests();
  list.resetForTests();

  let seq = 4000;
  let nextPort = 45000;
  const created = [];
  const bulkIds = [];

  function addGame(name) {
    nextPort += 1;
    const id = insertServer(db, {
      name,
      port: nextPort,
      dataPath: path.join(testRoot, `game-${name}`),
    });
    created.push(id);
    serverManager.invalidateServerCache(id);
    return id;
  }

  function setupRuntime(overrides = {}) {
    lifecycle.resetForTests();
    list.resetForTests();
    list.setReloadDelayMs(0);
    const alive = new Set();
    const spawned = [];
    const terminated = [];
    let busy19132 = Boolean(overrides.busy19132);
    let ownerPid = overrides.ownerPid || null;
    let pidSeq = seq;
    const runtime = {
      alive,
      spawned,
      terminated,
      get busy19132() { return busy19132; },
      set busy19132(value) { busy19132 = value; },
      get ownerPid() { return ownerPid; },
      set ownerPid(value) { ownerPid = value; },
    };

    lifecycle.configure({
      gracefulStopMs: overrides.gracefulStopMs ?? 40,
      forceStopMs: overrides.forceStopMs ?? 40,
      startupBindMs: overrides.startupBindMs ?? 400,
      pollMs: 10,
      assertJava: async () => {},
      javaCommand: 'java',
      installedJar: () => ({ tag: '1.68.0', jarPath }),
      releaseDiscoveryPorts: async () => {},
      isUdpAvailable: (port) => (Number(port) === 19132 ? !busy19132 : true),
      isUdp6Available: () => true,
      isPidAlive: (pid) => alive.has(Number(pid)),
      waitForPidExit: async (pid, timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (!alive.has(Number(pid))) return true;
          await sleep(5);
        }
        return !alive.has(Number(pid));
      },
      pidOwnsUdpPort: (pid, port) => {
        if (Number(port) !== 19132) return false;
        if (!busy19132) return false;
        if (ownerPid == null) return null;
        return Number(ownerPid) === Number(pid);
      },
      udpOwnerPids: (port) => {
        if (Number(port) !== 19132 || !busy19132 || !ownerPid) return [];
        return [ownerPid];
      },
      signalPid: (pid, signal) => {
        if (signal === 'SIGKILL') {
          alive.delete(Number(pid));
          if (Number(ownerPid) === Number(pid)) {
            busy19132 = false;
            ownerPid = null;
          }
        }
      },
      terminateProcessTree: async ({ pid }) => {
        terminated.push(Number(pid));
        if (overrides.terminateFails) {
          return { ok: false, method: 'force-failed', pid };
        }
        alive.delete(Number(pid));
        const session = lifecycle.currentSession(bc.id);
        if (session?.pty && !session.exited) session.pty.emit('exit', 1);
        if (Number(ownerPid) === Number(pid)) {
          busy19132 = false;
          ownerPid = null;
        }
        return { ok: true, method: 'forced' };
      },
      spawnPty: (bin, args, opts) => {
        pidSeq += 1;
        seq = pidSeq;
        const pty = new FakePty({
          pid: pidSeq,
          killNoExit: Boolean(overrides.killNoExit),
          exitDelayMs: overrides.exitDelayMs || 0,
        });
        if (!overrides.killNoExit) {
          const originalKill = pty.kill.bind(pty);
          pty.kill = () => {
            originalKill();
            if (!overrides.keepAliveOnKill) {
              setTimeout(() => {
                alive.delete(pty.pid);
                if (Number(ownerPid) === pty.pid) {
                  busy19132 = false;
                  ownerPid = null;
                }
              }, overrides.exitDelayMs || 0);
            }
          };
        }
        spawned.push({ bin, args, opts, pty });
        alive.add(pty.pid);
        if (overrides.bindDelayMs) {
          setTimeout(() => {
            busy19132 = true;
            ownerPid = pty.pid;
          }, overrides.bindDelayMs);
        } else if (!overrides.noBind) {
          busy19132 = true;
          ownerPid = pty.pid;
        }
        return pty;
      },
      ...overrides.extra,
    });
    return runtime;
  }

  function statusOf() {
    serverManager.invalidateServerCache(bc.id);
    return serverManager.getBedrockConnectServer();
  }

  // 1-4, 16, 23: list file contents and spawn args
  addGame('AlphaList');
  let written = list.writeList();
  assert.equal(written.written, true);
  let parsed = JSON.parse(fs.readFileSync(written.path, 'utf8'));
  assert.ok(parsed.some((item) => item.name === 'AlphaList'), 'custom_servers.json includes a newly created server');

  fs.writeFileSync(
    written.path,
    `${JSON.stringify([{ name: 'Test-10 Geyser — Geyser', address: '192.0.2.10', port: 19146 }], null, 2)}\n`
  );
  written = list.writeList();
  parsed = JSON.parse(fs.readFileSync(written.path, 'utf8'));
  assert.equal(parsed.some((item) => String(item.name).includes('—')), false);
  assert.equal(parsed.some((item) => String(item.name).includes('–')), false);
  assert.ok(parsed.some((item) => item.name === 'AlphaList'));

  const zeldaId = addGame('Zelda');
  written = list.writeList();
  parsed = JSON.parse(fs.readFileSync(written.path, 'utf8'));
  assert.ok(parsed.some((item) => item.name === 'Zelda'));
  db.prepare('DELETE FROM servers WHERE id = ?').run(zeldaId);
  serverManager.invalidateServerCache(zeldaId);
  written = list.writeList();
  parsed = JSON.parse(fs.readFileSync(written.path, 'utf8'));
  assert.equal(parsed.some((item) => item.name === 'Zelda'), false, 'deleted server is removed from the file');

  for (let i = 0; i < 12; i += 1) bulkIds.push(addGame(`Many-${i}`));
  written = list.writeList();
  parsed = JSON.parse(fs.readFileSync(written.path, 'utf8'));
  assert.ok(parsed.length > 10, 'more than 10 eligible servers are written');

  for (let i = 0; i < 90; i += 1) bulkIds.push(addGame(`Cap-${i}`));
  written = list.writeList();
  parsed = JSON.parse(fs.readFileSync(written.path, 'utf8'));
  assert.ok(parsed.length <= 100, 'list is capped at 100');
  assert.equal(parsed.length === 100 || written.truncated, true, 'up to 100 entries are supported');
  for (const id of bulkIds) {
    db.prepare('DELETE FROM servers WHERE id = ?').run(id);
    serverManager.invalidateServerCache(id);
  }

  addGame('mim');
  written = list.writeList();
  parsed = JSON.parse(fs.readFileSync(written.path, 'utf8'));
  assert.ok(parsed.some((item) => item.name === 'mim'));
  assert.equal(parsed.some((item) => item.name === 'Zelda'), false);

  const args = list.spawnArgs(dataPath);
  assert.ok(args.includes('server_limit=100'));
  assert.ok(args.some((item) => item.startsWith('custom_servers=')));

  // 5. Start reports success only after UDP 19132 is bound.
  let runtime = setupRuntime({ bindDelayMs: 40, startupBindMs: 400 });
  db.prepare("UPDATE servers SET status = 'stopped', pid = NULL WHERE id = ?").run(bc.id);
  serverManager.invalidateServerCache(bc.id);
  const started = await serverManager.startServer(bc.id);
  assert.equal(started.success, true);
  assert.equal(statusOf().status, 'running');
  assert.ok(runtime.ownerPid);
  assert.equal(runtime.spawned.length, 1);
  assert.ok(runtime.spawned[0].args.includes('server_limit=100'));

  // 6. Start fails if UDP 19132 remains occupied.
  await serverManager.stopServer(bc.id);
  runtime = setupRuntime({ busy19132: true, ownerPid: 9999 });
  db.prepare("UPDATE servers SET status = 'stopped', pid = NULL WHERE id = ?").run(bc.id);
  serverManager.invalidateServerCache(bc.id);
  await assert.rejects(() => serverManager.startServer(bc.id), /occupied|19132/);
  assert.equal(runtime.spawned.length, 0);
  assert.equal(statusOf().status, 'failed');

  // 7. A failed start is not marked running.
  runtime = setupRuntime({ noBind: true, startupBindMs: 50 });
  db.prepare("UPDATE servers SET status = 'stopped', pid = NULL, pending_restart_reason = NULL WHERE id = ?").run(bc.id);
  serverManager.invalidateServerCache(bc.id);
  await assert.rejects(() => serverManager.startServer(bc.id), /timeout|bind|19132/);
  assert.notEqual(statusOf().status, 'running');
  assert.equal(statusOf().status, 'failed');

  // 8. Stop waits for confirmed process exit.
  runtime = setupRuntime({ exitDelayMs: 40 });
  db.prepare("UPDATE servers SET status = 'stopped', pid = NULL, pending_restart_reason = NULL WHERE id = ?").run(bc.id);
  serverManager.invalidateServerCache(bc.id);
  await serverManager.startServer(bc.id);
  const pidToStop = lifecycle.currentSession(bc.id).pid;
  const stopStarted = Date.now();
  await serverManager.stopServer(bc.id);
  assert.ok(Date.now() - stopStarted >= 30, 'stop waited for process exit');
  assert.equal(runtime.alive.has(pidToStop), false);
  assert.equal(statusOf().status, 'stopped');

  // 9. Graceful-stop timeout triggers targeted forced termination.
  runtime = setupRuntime({ killNoExit: true, keepAliveOnKill: true, gracefulStopMs: 40 });
  db.prepare("UPDATE servers SET status = 'stopped', pid = NULL WHERE id = ?").run(bc.id);
  serverManager.invalidateServerCache(bc.id);
  await serverManager.startServer(bc.id);
  const forcedPid = lifecycle.currentSession(bc.id).pid;
  await serverManager.stopServer(bc.id);
  assert.ok(runtime.terminated.includes(forcedPid));
  assert.equal(statusOf().status, 'stopped');

  // 10. Stop failure does not mark the server stopped.
  runtime = setupRuntime({ killNoExit: true, keepAliveOnKill: true, terminateFails: true, gracefulStopMs: 30 });
  db.prepare("UPDATE servers SET status = 'stopped', pid = NULL WHERE id = ?").run(bc.id);
  serverManager.invalidateServerCache(bc.id);
  await serverManager.startServer(bc.id);
  await assert.rejects(() => serverManager.stopServer(bc.id), /remains active/);
  assert.notEqual(statusOf().status, 'stopped');
  assert.equal(statusOf().status, 'failed');
  assert.ok(lifecycle.currentSession(bc.id), 'session remains when stop fails');

  // 11. A replacement is not launched while the old PID remains alive.
  const beforeSpawn = runtime.spawned.length;
  await assert.rejects(() => serverManager.startServer(bc.id), /remains alive|already running|stopping|occupied/);
  assert.equal(runtime.spawned.length, beforeSpawn);

  runtime.alive.delete(lifecycle.currentSession(bc.id)?.pid);
  db.prepare("UPDATE servers SET status = 'failed' WHERE id = ?").run(bc.id);
  serverManager.invalidateServerCache(bc.id);
  lifecycle.resetForTests();

  // 12. Stale PTY exit handlers cannot remove a newer session.
  runtime = setupRuntime();
  db.prepare("UPDATE servers SET status = 'stopped', pid = NULL, pending_restart_reason = NULL WHERE id = ?").run(bc.id);
  serverManager.invalidateServerCache(bc.id);
  await serverManager.startServer(bc.id);
  const firstPty = lifecycle.currentSession(bc.id).pty;
  const firstToken = lifecycle.currentSession(bc.id).token;
  runtime.alive.delete(lifecycle.currentSession(bc.id).pid);
  runtime.busy19132 = false;
  runtime.ownerPid = null;
  db.prepare("UPDATE servers SET status = 'stopped' WHERE id = ?").run(bc.id);
  serverManager.invalidateServerCache(bc.id);
  await serverManager.startServer(bc.id);
  const second = lifecycle.currentSession(bc.id);
  assert.notEqual(second.token, firstToken);
  firstPty.emit('exit', 0);
  await sleep(20);
  assert.equal(lifecycle.currentSession(bc.id).token, second.token);
  assert.equal(statusOf().status, 'running');
  await serverManager.stopServer(bc.id);

  // 13-15. Coalesced restarts and newest generation.
  runtime = setupRuntime({ exitDelayMs: 20 });
  db.prepare("UPDATE servers SET status = 'stopped', pid = NULL WHERE id = ?").run(bc.id);
  serverManager.invalidateServerCache(bc.id);
  await serverManager.startServer(bc.id);
  const spawnsBefore = runtime.spawned.length;
  addGame('Rapid-1');
  addGame('Rapid-2');
  addGame('Rapid-3');
  list.requestRefresh();
  list.requestRefresh();
  list.requestRefresh();
  await waitUntil(() => runtime.spawned.length > spawnsBefore && statusOf().status === 'running', 3000, 'coalesced restart');
  await sleep(80);
  const afterRapid = runtime.spawned.length;
  assert.ok(afterRapid - spawnsBefore <= 3, 'rapid list changes were coalesced');
  assert.ok(afterRapid > spawnsBefore, 'running process was restarted for list changes');
  const loaded = JSON.parse(fs.readFileSync(list.writeList().path, 'utf8'));
  assert.ok(loaded.some((item) => item.name === 'Rapid-3'));
  assert.equal(lifecycle.currentSession(bc.id).listHash, list.writeList().hash);

  // 14. A list change during restart schedules a follow-up reload.
  const spawnsMid = runtime.spawned.length;
  runtime = Object.assign(runtime, {});
  lifecycle.configure({
    startupBindMs: 400,
    spawnPty: (bin, args, opts) => {
      const pty = new FakePty({ pid: (seq += 1), exitDelayMs: 0 });
      runtime.spawned.push({ bin, args, opts, pty });
      runtime.alive.add(pty.pid);
      const originalKill = pty.kill.bind(pty);
      pty.kill = () => {
        originalKill();
        setTimeout(() => {
          runtime.alive.delete(pty.pid);
          if (Number(runtime.ownerPid) === pty.pid) {
            runtime.busy19132 = false;
            runtime.ownerPid = null;
          }
        }, 0);
      };
      setTimeout(() => {
        runtime.busy19132 = true;
        runtime.ownerPid = pty.pid;
      }, 60);
      return pty;
    },
  });
  addGame('During-Restart');
  list.requestRefresh();
  await sleep(30);
  addGame('Follow-Up');
  list.requestRefresh();
  await waitUntil(() => {
    const names = JSON.parse(fs.readFileSync(list.writeList().path, 'utf8')).map((item) => item.name);
    const session = lifecycle.currentSession(bc.id);
    return session
      && statusOf().status === 'running'
      && names.includes('Follow-Up')
      && session.listHash === list.writeList().hash;
  }, 4000, 'follow-up reload');
  assert.ok(runtime.spawned.length >= spawnsMid + 1);

  // 16 already asserted mim/Zelda; confirm running instance tracks that JSON
  const runningList = JSON.parse(fs.readFileSync(list.writeList().path, 'utf8'));
  assert.ok(runningList.some((item) => item.name === 'mim'));
  assert.equal(runningList.some((item) => item.name === 'Zelda'), false);
  assert.equal(lifecycle.currentSession(bc.id).listHash, list.writeList().hash);

  // 17. Manager startup does not create duplicate BedrockConnect processes.
  const spawnCount = runtime.spawned.length;
  const killed = [];
  lifecycle.configure({
    processIdentity: async () => ({
      pid: 4242,
      cmdline: `${jarPath} BedrockConnect-1.0-SNAPSHOT.jar`,
      exe: 'java',
    }),
    udpOwnerPids: (port) => (Number(port) === 19132 ? [4242] : []),
    terminateProcessTree: async ({ pid }) => {
      killed.push(pid);
      return { ok: true, method: 'forced' };
    },
  });
  const reconcile = await lifecycle.reconcileOnStartup();
  assert.ok(killed.includes(4242));
  assert.equal(runtime.spawned.length, spawnCount, 'reconcile must not spawn a duplicate');
  assert.equal(reconcile.adopted, false);

  const otherId = insertServer(db, {
    name: `KeepRunning-${Date.now()}`,
    port: nextPort + 50,
    dataPath: path.join(testRoot, 'keep-running'),
  });
  const otherPty = new FakePty({ pid: 8800 });
  serverManager.ptySessions.set(String(otherId), otherPty);

  await serverManager.shutdown();
  assert.equal(lifecycle.currentSession(bc.id), null);
  assert.notEqual(statusOf().status, 'running');

  // 22. Minecraft Bedrock servers continue running during a BedrockConnect-only restart.
  runtime = setupRuntime({ exitDelayMs: 10 });
  db.prepare("UPDATE servers SET status = 'stopped', pid = NULL WHERE id = ?").run(bc.id);
  serverManager.invalidateServerCache(bc.id);
  serverManager.ptySessions.set(String(otherId), otherPty);
  await serverManager.startServer(bc.id);
  await serverManager.restartServer(bc.id);
  assert.equal(serverManager.ptySessions.get(String(otherId)), otherPty);
  assert.equal(statusOf().status, 'running');
  await serverManager.stopServer(bc.id);

  logger.info('Bedrock Connect lifecycle tests passed', { created: created.length });
}

module.exports = { runBedrockConnectLifecycleTests };

if (require.main === module) {
  const os = require('os');
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-lifecycle-'));
  process.env.MC_MANAGER_DB_PATH = path.join(testRoot, 'mc_manager.db');
  process.env.MC_MANAGER_USER_PLUGINS_DIR = path.join(testRoot, 'plugins');
  process.env.MC_MANAGER_PLUGIN_DATA_DIR = path.join(testRoot, 'plugin-data');
  process.env.MC_MANAGER_PLUGIN_STATE_PATH = path.join(testRoot, 'plugin-state.json');
  const db = require('../server/db/connection');
  const serverManager = require('../server/services/serverManager');
  runBedrockConnectLifecycleTests({ testRoot, db, serverManager })
    .then(() => {
      console.log(JSON.stringify({ bedrockConnectLifecycle: 'ok' }));
      db.close();
      fs.rmSync(testRoot, { recursive: true, force: true });
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      try { db.close(); } catch { /* ignore */ }
      process.exit(1);
    });
}
