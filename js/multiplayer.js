/* ===========================================================================
   multiplayer.js — hosting, joining, and keeping everyone in sync
   ---------------------------------------------------------------------------
   PeerJS is used only for the initial handshake through a free public broker;
   all race traffic afterwards travels directly between browsers.

   Latency design. Every machine simulates its own car locally, so your own
   inputs are never delayed. Two things stop the host having an advantage:
     * an NTP-style ping/pong estimates the host's clock on every client, so
       the race start, lap times and finish order all live on one timeline;
     * state packets carry a timestamp and velocity, and remote cars are
       dead-reckoned forward to the present instant before being drawn, so a
       50 ms and a 150 ms link look the same on screen.

   Timing and rates are in config.js under `net`.
   =========================================================================== */

GAME.Net = {};

(function () {
  'use strict';

  var Net = GAME.Net;

  // ---- public, live state (other modules read these) ------------------------
  Net.players = {};        // peerId -> { name, liveryIndex, isHost, gridIndex }
  Net.remoteCars = {};     // peerId -> { group, current, net, liveryIndex }
  Net.raceResults = [];    // finishing order; the host is the authority
  Net.myPlayerId = null;
  Net.myPlayerName = '';
  Net.myGridIndex = 0;

  // ---- private --------------------------------------------------------------
  var scene = null;
  var active = false;
  var role = null;           // 'host' | 'client'
  var peer = null;
  var hostConn = null;       // client -> host, reliable control channel
  var hostFast = null;       // client -> host, unreliable low-latency channel
  var clientConns = {};      // host: peerId -> reliable control connection
  var fastConns = {};        // host: peerId -> unreliable state connection
  var netStates = {};        // host: peerId -> newest state packet
  var nextGridIndex = 1;
  var sessionName = '', sessionPassword = '';
  var sendAccum = 0, standingsAccum = 0;

  // ---- shared network clock -------------------------------------------------
  var timeOffset = 0;        // performance.now() + offset ≈ the host's clock
  var halfRTT = 0;
  var synced = false;
  var clockSamples = [];
  var lastPingAt = 0;

  function netNow() { return performance.now() + timeOffset; }
  // Everything that needs a timestamp uses this: host clock online, local
  // clock offline, so the same code paths work in both modes.
  function gameNow() { return active ? netNow() : performance.now(); }

  function resetClockSync() {
    timeOffset = 0; halfRTT = 0; synced = false; clockSamples = []; lastPingAt = 0;
  }
  function pumpClockSync() {
    if (!active || role !== 'client') return;
    var now = performance.now();
    var interval = clockSamples.length < 10 ? 150 : 1500;  // burst, then trickle
    if (now - lastPingAt < interval) return;
    lastPingAt = now;
    sendToHost({ type: 'ping', t0: now }, true);
  }
  function handlePong(msg) {
    var t1 = performance.now();
    var rtt = t1 - msg.t0;
    if (rtt < 0 || rtt > 4000) return;
    var offset = msg.tHost + rtt / 2 - t1;
    clockSamples.push({ rtt: rtt, offset: offset });
    if (clockSamples.length > 16) clockSamples.shift();
    var best = clockSamples[0];
    for (var i = 1; i < clockSamples.length; i++) {
      if (clockSamples[i].rtt < best.rtt) best = clockSamples[i];
    }
    halfRTT = best.rtt / 2;
    if (!synced) { timeOffset = best.offset; synced = true; }
    else timeOffset += (best.offset - timeOffset) * 0.2;
    updateLobbyPing();
  }
  function updateLobbyPing() {
    if (GAME.State.state !== 'mp-lobby' || role !== 'client') return;
    var el = document.getElementById('lobbyPing');
    if (el) el.textContent = synced ? ('Clock synced — ping ' + Math.round(halfRTT * 2) + ' ms') : 'Syncing clocks…';
  }

  // ---- send helpers ---------------------------------------------------------
  // preferFast picks the unreliable channel, which has no retransmit stalls —
  // right for state that is obsolete the moment it is late.
  function sendToHost(msg, preferFast) {
    var c = (preferFast && hostFast && hostFast.open) ? hostFast : hostConn;
    if (c && c.open) { try { c.send(msg); } catch (e) {} }
  }
  function sendToClient(pid, msg, preferFast) {
    var c = (preferFast && fastConns[pid] && fastConns[pid].open) ? fastConns[pid] : clientConns[pid];
    if (c && c.open) { try { c.send(msg); } catch (e) {} }
  }
  function broadcast(msg, preferFast) {
    Object.keys(clientConns).forEach(function (pid) { sendToClient(pid, msg, preferFast); });
  }

  function sessionIdFromName(name) {
    var slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');
    return 'f1rac-' + slug;
  }
  function randomPeerId() { return 'f1rac-p-' + Math.random().toString(36).slice(2, 10); }

  // ---- remote cars ----------------------------------------------------------
  function positionCarAtGrid(rc, gridIndex) {
    var slot = GAME.State.track.gridSlot(gridIndex || 0);
    rc.current.x = slot.x; rc.current.y = slot.y; rc.current.angle = slot.angle;
    rc.net = null;
    rc.group.position.set(slot.x, 0, slot.y);
    rc.group.rotation.y = -slot.angle;
  }
  function spawnRemoteCarIfNeeded(pid) {
    if (Net.remoteCars[pid]) return Net.remoteCars[pid];
    var p = Net.players[pid];
    var liveryIdx = (p && p.liveryIndex) || 0;
    var gIdx = (p && typeof p.gridIndex === 'number') ? p.gridIndex : (Object.keys(Net.remoteCars).length + 1);
    var slot = GAME.State.track.gridSlot(gIdx);
    var built = GAME.CarModel.create(GAME.Liveries[liveryIdx].colors);
    built.group.position.set(slot.x, 0, slot.y);
    built.group.rotation.y = -slot.angle;
    scene.add(built.group);
    var rc = {
      group: built.group,
      current: { x: slot.x, y: slot.y, angle: slot.angle },
      net: null,
      liveryIndex: liveryIdx
    };
    Net.remoteCars[pid] = rc;
    return rc;
  }
  function updateRemoteCarLivery(pid) {
    var rc = Net.remoteCars[pid];
    if (!rc || !Net.players[pid]) return;
    var idx = Net.players[pid].liveryIndex || 0;
    if (rc.liveryIndex === idx) return;
    scene.remove(rc.group);
    var built = GAME.CarModel.create(GAME.Liveries[idx].colors);
    built.group.position.copy(rc.group.position);
    built.group.rotation.copy(rc.group.rotation);
    scene.add(built.group);
    rc.group = built.group;
    rc.liveryIndex = idx;
  }
  function removeRemoteCar(pid) {
    var rc = Net.remoteCars[pid];
    if (!rc) return;
    scene.remove(rc.group);
    delete Net.remoteCars[pid];
    GAME.Hud.setNameLabel(pid, null);
  }

  // Dead reckoning: project each car forward from the instant its packet was
  // sampled to right now. Extrapolation is capped so a dropped-out player
  // coasts to a stop instead of teleporting when they come back.
  function updateRemoteCars(dt) {
    var cfg = GAME.Config.net;
    var now = netNow();
    Object.keys(Net.remoteCars).forEach(function (pid) {
      var rc = Net.remoteCars[pid];
      var tx = rc.current.x, ty = rc.current.y, ta = rc.current.angle;
      var n = rc.net;
      if (n) {
        var age = GAME.Physics.clamp((now - n.t) / 1000, 0, cfg.maxExtrapolate);
        tx = n.x + n.vx * age;
        ty = n.y + n.vy * age;
        ta = n.angle + n.av * age;
      }
      var s = Math.min(1, dt * cfg.smoothing);
      rc.current.x += (tx - rc.current.x) * s;
      rc.current.y += (ty - rc.current.y) * s;
      var da = ta - rc.current.angle;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      rc.current.angle += da * s;
      rc.group.position.set(rc.current.x, 0, rc.current.y);
      rc.group.rotation.y = -rc.current.angle;
    });
    GAME.Hud.updateNameLabels();
  }

  function applyRemoteState(pid, s) {
    if (!pid || pid === Net.myPlayerId) return;
    var rc = Net.remoteCars[pid] || spawnRemoteCarIfNeeded(pid);
    if (rc.net && s.t < rc.net.t) return;   // the unreliable channel can reorder
    rc.net = {
      t: s.t, x: s.x, y: s.y, angle: s.angle,
      vx: s.vx || 0, vy: s.vy || 0, av: s.av || 0,
      lap: s.lap || 0, prog: s.prog || 0
    };
    if (Net.players[pid]) { Net.players[pid].lap = s.lap; Net.players[pid].prog = s.prog; }
  }
  function myStatePacket() {
    var S = GAME.State;
    return {
      id: Net.myPlayerId, t: netNow(),
      x: S.car.x, y: S.car.y, angle: S.car.angle,
      vx: S.car.wvx, vy: S.car.wvy, av: S.car.av,
      lap: S.lapCount, prog: S.progress
    };
  }
  function sendState() {
    if (role === 'client') {
      sendToHost({ type: 'state', s: myStatePacket() }, true);
      return;
    }
    // Host batches everybody into one packet per tick; every entry keeps its
    // own sample timestamp so the extra hop costs nothing once extrapolated.
    var list = [myStatePacket()];
    Object.keys(netStates).forEach(function (pid) { list.push(netStates[pid]); });
    broadcast({ type: 'states', list: list }, true);
  }

  // ---- standings ------------------------------------------------------------
  function currentStandings() {
    var S = GAME.State;
    var finishedById = {};
    for (var i = 0; i < Net.raceResults.length; i++) finishedById[Net.raceResults[i].id] = Net.raceResults[i];
    var list = [];
    Object.keys(Net.players).forEach(function (pid) {
      var p = Net.players[pid];
      var fin = finishedById[pid];
      var prog = 0, lap = 0;
      if (pid === Net.myPlayerId) { prog = S.progress; lap = S.lapCount; }
      else if (Net.remoteCars[pid] && Net.remoteCars[pid].net) {
        prog = Net.remoteCars[pid].net.prog;
        lap = Net.remoteCars[pid].net.lap;
      }
      list.push({
        id: pid, name: p.name, prog: prog, lap: lap,
        me: pid === Net.myPlayerId,
        place: fin ? fin.place : null,
        totalMs: fin ? fin.totalMs : null
      });
    });
    // finishers lock in by classified place; everyone else ranks live by
    // how far around the circuit they are
    list.sort(function (a, b) {
      if (a.place && b.place) return a.place - b.place;
      if (a.place) return -1;
      if (b.place) return 1;
      return b.prog - a.prog;
    });
    return list;
  }
  function myPlace() {
    var list = currentStandings();
    for (var i = 0; i < list.length; i++) if (list[i].me) return i + 1;
    return 1;
  }

  // ---- results --------------------------------------------------------------
  function addResult(entry) {   // host only
    for (var i = 0; i < Net.raceResults.length; i++) if (Net.raceResults[i].id === entry.id) return;
    Net.raceResults.push(entry);
    // sorted on the shared clock, so a laggy link can't cost you a place
    Net.raceResults.sort(function (a, b) { return a.finishNet - b.finishNet; });
    for (var j = 0; j < Net.raceResults.length; j++) Net.raceResults[j].place = j + 1;
    broadcast({ type: 'results', results: Net.raceResults });
    GAME.Hud.renderResults();
    GAME.Hud.renderStandings();
  }
  function reportFinish(totalMs, bestMs) {
    if (!active) return;
    var entry = {
      id: Net.myPlayerId, name: Net.myPlayerName,
      totalMs: totalMs, bestLapMs: bestMs, finishNet: gameNow()
    };
    if (role === 'host') addResult(entry);
    else sendToHost({ type: 'finish', entry: entry });
  }

  // ---- lobby ----------------------------------------------------------------
  function broadcastRoster() { broadcast({ type: 'roster', players: Net.players }); }

  function refreshLobbyUI() {
    var list = document.getElementById('lobbyPlayerList');
    list.innerHTML = '';
    var order = Object.keys(Net.players).sort(function (a, b) {
      return (Net.players[a].gridIndex || 0) - (Net.players[b].gridIndex || 0);
    });
    order.forEach(function (pid) {
      var p = Net.players[pid];
      var row = document.createElement('div');
      row.className = 'player-row';
      row.innerHTML = '<span><span class="host-tag" style="color:#8fa3b8;">P' + ((p.gridIndex || 0) + 1) + '</span> ' +
        GAME.Hud.escapeHtml(p.name) +
        (p.isHost ? ' <span class="host-tag">HOST</span>' : '') +
        (pid === Net.myPlayerId ? ' <span class="you-tag">YOU</span>' : '') + '</span>' +
        '<span>' + GAME.Hud.escapeHtml((GAME.Liveries[p.liveryIndex] || GAME.Liveries[0]).name) + '</span>';
      list.appendChild(row);
    });
  }

  function populateLobbyLiverySelect() {
    var sel = document.getElementById('lobbyLiverySelect');
    sel.innerHTML = '';
    GAME.Liveries.forEach(function (item, i) {
      if (item.available === false) return;
      var opt = document.createElement('option');
      opt.value = i;
      opt.textContent = item.name;
      sel.appendChild(opt);
    });
    sel.value = GAME.State.selectedLiveryIndex;
    sel.onchange = function () {
      GAME.State.selectedLiveryIndex = parseInt(sel.value, 10);
      GAME.Game.rebuildPlayerCar();
      if (Net.players[Net.myPlayerId]) Net.players[Net.myPlayerId].liveryIndex = GAME.State.selectedLiveryIndex;
      if (role === 'host') {
        broadcastRoster();
        refreshLobbyUI();
      } else {
        sendToHost({ type: 'livery', liveryIndex: GAME.State.selectedLiveryIndex });
      }
    };
  }

  // Only the host picks the track; clients are told which one at lights-out.
  function populateLobbyTrackSelect() {
    var row = document.getElementById('lobbyTrackRow');
    if (!row) return;
    row.style.display = (role === 'host') ? 'block' : 'none';
    if (role !== 'host') return;
    var sel = document.getElementById('lobbyTrackSelect');
    sel.innerHTML = '';
    GAME.Tracks.forEach(function (item, i) {
      if (item.available === false) return;
      var opt = document.createElement('option');
      opt.value = i;
      opt.textContent = item.name;
      sel.appendChild(opt);
    });
    sel.value = GAME.State.selectedTrackIndex;
    sel.onchange = function () {
      GAME.State.selectedTrackIndex = parseInt(sel.value, 10);
      GAME.Game.loadTrack(GAME.State.selectedTrackIndex);
      Object.keys(Net.remoteCars).forEach(function (pid) {
        var gIdx = (Net.players[pid] && typeof Net.players[pid].gridIndex === 'number') ? Net.players[pid].gridIndex : 1;
        positionCarAtGrid(Net.remoteCars[pid], gIdx);
      });
    };
  }

  function enterLobbyView() {
    GAME.State.state = 'mp-lobby';
    GAME.Menus.showScreen('screenLobby');
    GAME.Hud.renderStandings();
    document.getElementById('lobbyTitle').textContent =
      role === 'host' ? 'Hosting: ' + sessionName : 'Session: ' + sessionName;
    document.getElementById('lobbySessionInfo').textContent = role === 'host'
      ? ('Share the session name "' + sessionName + '"' + (sessionPassword ? ' and your password' : '') + ' with friends to join.')
      : 'Waiting for the host to start the race.';
    document.getElementById('lobbyStartBtn').style.display = role === 'host' ? 'inline-block' : 'none';
    document.getElementById('lobbyStatusMsg').textContent = '';
    var pingEl = document.getElementById('lobbyPing');
    if (pingEl) {
      pingEl.textContent = role === 'host'
        ? 'You are the timing reference for this session.'
        : (synced ? 'Clock synced — ping ' + Math.round(halfRTT * 2) + ' ms' : 'Syncing clocks…');
    }
    populateLobbyTrackSelect();
    populateLobbyLiverySelect();
    refreshLobbyUI();
  }

  function leaveLobbyToRace(startAt, trackIndex) {
    // the host's track choice wins, so everyone races the same circuit
    if (typeof trackIndex === 'number' && GAME.Tracks[trackIndex]) {
      GAME.State.selectedTrackIndex = trackIndex;
      GAME.Game.loadTrack(trackIndex);
    }
    GAME.Game.rebuildPlayerCar();
    GAME.Game.resetCarToGrid();
    Object.keys(Net.remoteCars).forEach(function (pid) {
      var gIdx = (Net.players[pid] && typeof Net.players[pid].gridIndex === 'number') ? Net.players[pid].gridIndex : 1;
      positionCarAtGrid(Net.remoteCars[pid], gIdx);
    });
    GAME.Game.resetRaceCounters();
    Net.raceResults = [];
    document.getElementById('scoreBox').classList.add('hidden');
    GAME.Hud.hideResults();
    GAME.Menus.showScreen('screenRace');
    document.getElementById('ovTitle').textContent = 'Multiplayer — ' + sessionName;
    document.getElementById('ovSub').textContent = '';
    document.getElementById('ovBtn').style.display = 'none';
    document.getElementById('menuBtn').style.display = 'none';
    GAME.Hud.refreshNameLabels();
    GAME.Hud.update(0);
    GAME.Game.beginCountdown(startAt);
    GAME.Hud.renderStandings();
  }

  function leave() {
    if (role === 'host') broadcast({ type: 'leave' });
    else sendToHost({ type: 'leave' });
    if (peer) { try { peer.destroy(); } catch (e) {} }
    peer = null; hostConn = null; hostFast = null;
    clientConns = {}; fastConns = {}; netStates = {};
    Net.players = {}; Net.raceResults = [];
    Object.keys(Net.remoteCars).forEach(removeRemoteCar);
    GAME.Hud.clearNameLabels();
    active = false; role = null; Net.myPlayerId = null;
    resetClockSync();
    GAME.Hud.renderStandings();
  }

  function handlePlayerLeft(pid) {
    delete clientConns[pid];
    delete fastConns[pid];
    delete Net.players[pid];
    delete netStates[pid];
    removeRemoteCar(pid);
    if (role === 'host') broadcastRoster();
    if (GAME.State.state === 'mp-lobby') refreshLobbyUI();
  }

  // ---- host side ------------------------------------------------------------
  function handleHostMessage(conn, msg) {
    if (msg.type === 'ping') {
      try { conn.send({ type: 'pong', t0: msg.t0, tHost: performance.now() }); } catch (e) {}
      return;
    }
    if (msg.type === 'hello') {
      if (sessionPassword && msg.password !== sessionPassword) {
        conn.send({ type: 'reject', reason: 'Wrong password.' });
        setTimeout(function () { conn.close(); }, 250);
        return;
      }
      if (Object.keys(Net.players).length >= GAME.Config.race.maxPlayers) {
        conn.send({ type: 'reject', reason: 'Session is full.' });
        setTimeout(function () { conn.close(); }, 250);
        return;
      }
      clientConns[conn.peer] = conn;
      var joinLiveryIdx = (typeof msg.liveryIndex === 'number' &&
        GAME.Liveries[msg.liveryIndex] && GAME.Liveries[msg.liveryIndex].available !== false) ? msg.liveryIndex : 0;
      Net.players[conn.peer] = {
        name: (msg.name || 'Driver').slice(0, 16),
        liveryIndex: joinLiveryIdx, isHost: false, gridIndex: nextGridIndex++
      };
      conn.send({ type: 'welcome', you: conn.peer, sessionName: sessionName, players: Net.players });
      broadcastRoster();
      spawnRemoteCarIfNeeded(conn.peer);
      if (GAME.State.state === 'mp-lobby') refreshLobbyUI();
      if (GAME.State.state === 'racing' || GAME.State.state === 'countdown') GAME.Hud.refreshNameLabels();
    } else if (msg.type === 'livery') {
      if (Net.players[conn.peer]) {
        Net.players[conn.peer].liveryIndex = msg.liveryIndex;
        broadcastRoster();
        if (GAME.State.state === 'mp-lobby') refreshLobbyUI();
        updateRemoteCarLivery(conn.peer);
      }
    } else if (msg.type === 'state') {
      var s = msg.s;
      if (!s) return;
      s.id = conn.peer;
      var prev = netStates[conn.peer];
      if (prev && s.t < prev.t) return;
      netStates[conn.peer] = s;
      applyRemoteState(conn.peer, s);
    } else if (msg.type === 'finish') {
      if (msg.entry) { msg.entry.id = conn.peer; addResult(msg.entry); }
    } else if (msg.type === 'leave') {
      handlePlayerLeft(conn.peer);
    }
  }

  function createSession() {
    var name = document.getElementById('hostName').value.trim();
    var session = document.getElementById('hostSession').value.trim();
    var pw = document.getElementById('hostPassword').value;
    var errEl = document.getElementById('hostError');
    errEl.textContent = '';
    if (!name) { errEl.textContent = 'Enter your name.'; return; }
    if (!session) { errEl.textContent = 'Enter a session name.'; return; }
    errEl.textContent = 'Connecting…';
    Net.myPlayerName = name; sessionName = session; sessionPassword = pw;

    peer = new Peer(sessionIdFromName(session), { debug: 0 });
    peer.on('open', function () {
      role = 'host'; active = true; Net.myPlayerId = 'host';
      resetClockSync(); synced = true;   // the host IS the reference clock
      Net.myGridIndex = 0; nextGridIndex = 1;
      Net.players = {};
      Net.players.host = { name: Net.myPlayerName, liveryIndex: GAME.State.selectedLiveryIndex, isHost: true, gridIndex: 0 };
      clientConns = {}; fastConns = {}; netStates = {}; Net.raceResults = [];
      enterLobbyView();
    });
    peer.on('connection', function (conn) {
      conn.on('open', function () {
        if (conn.label === 'fast') {
          fastConns[conn.peer] = conn;
          conn.on('data', function (msg) { handleHostMessage(conn, msg); });
          conn.on('close', function () { delete fastConns[conn.peer]; });
        } else {
          conn.on('data', function (msg) { handleHostMessage(conn, msg); });
          conn.on('close', function () { handlePlayerLeft(conn.peer); });
        }
      });
    });
    peer.on('error', function (e) {
      errEl.textContent = (e && e.type === 'unavailable-id')
        ? 'That session name is taken — pick another.'
        : 'Could not create session (' + (e && e.type || 'error') + ').';
      peer = null;
    });
  }

  // ---- client side ----------------------------------------------------------
  function handleClientMessage(msg) {
    if (msg.type === 'pong') {
      handlePong(msg);
    } else if (msg.type === 'welcome') {
      role = 'client'; active = true; Net.myPlayerId = msg.you; sessionName = msg.sessionName;
      Net.players = msg.players;
      Net.myGridIndex = (Net.players[Net.myPlayerId] && typeof Net.players[Net.myPlayerId].gridIndex === 'number')
        ? Net.players[Net.myPlayerId].gridIndex : 1;
      Object.keys(Net.players).forEach(function (pid) { if (pid !== Net.myPlayerId) spawnRemoteCarIfNeeded(pid); });
      openFastChannel();
      enterLobbyView();
    } else if (msg.type === 'reject') {
      document.getElementById('joinError').textContent = msg.reason || 'Could not join.';
      if (peer) { try { peer.destroy(); } catch (e) {} peer = null; }
    } else if (msg.type === 'roster') {
      Net.players = msg.players;
      Object.keys(Net.players).forEach(function (pid) { if (pid !== Net.myPlayerId) spawnRemoteCarIfNeeded(pid); });
      Object.keys(Net.remoteCars).forEach(function (pid) { if (!Net.players[pid]) removeRemoteCar(pid); });
      if (GAME.State.state === 'mp-lobby') refreshLobbyUI();
      else GAME.Hud.refreshNameLabels();
    } else if (msg.type === 'start') {
      leaveLobbyToRace(msg.startAt, msg.trackIndex);
    } else if (msg.type === 'states') {
      for (var i = 0; i < msg.list.length; i++) applyRemoteState(msg.list[i].id, msg.list[i]);
    } else if (msg.type === 'results') {
      Net.raceResults = msg.results || [];
      GAME.Hud.renderResults();
      GAME.Hud.renderStandings();
    } else if (msg.type === 'leave') {
      document.getElementById('lobbyStatusMsg').textContent = 'The host ended the session.';
      leave();
      setTimeout(function () { GAME.State.state = 'mode'; GAME.Menus.showScreen('screenMode'); }, 1200);
    }
  }

  function openFastChannel() {
    if (!peer || hostFast) return;
    try {
      hostFast = peer.connect(sessionIdFromName(sessionName), {
        label: 'fast', reliable: false, serialization: 'json'
      });
      hostFast.on('data', handleClientMessage);
      hostFast.on('close', function () { hostFast = null; });
      hostFast.on('error', function () { hostFast = null; });
    } catch (e) { hostFast = null; }
  }

  function joinSession() {
    var name = document.getElementById('joinName').value.trim();
    var session = document.getElementById('joinSession').value.trim();
    var pw = document.getElementById('joinPassword').value;
    var errEl = document.getElementById('joinError');
    errEl.textContent = '';
    if (!name) { errEl.textContent = 'Enter your name.'; return; }
    if (!session) { errEl.textContent = 'Enter the session name.'; return; }
    errEl.textContent = 'Connecting…';
    Net.myPlayerName = name; sessionName = session;
    resetClockSync();
    var hostPeerId = sessionIdFromName(session);

    peer = new Peer(randomPeerId(), { debug: 0 });
    peer.on('open', function () {
      hostConn = peer.connect(hostPeerId, { reliable: true, label: 'ctrl' });
      hostConn.on('open', function () {
        hostConn.send({
          type: 'hello', name: Net.myPlayerName, password: pw,
          liveryIndex: GAME.State.selectedLiveryIndex
        });
      });
      hostConn.on('data', handleClientMessage);
      hostConn.on('close', function () {
        if (active) {
          document.getElementById('lobbyStatusMsg').textContent = 'Connection to host lost.';
          leave();
          setTimeout(function () { GAME.State.state = 'mode'; GAME.Menus.showScreen('screenMode'); }, 1200);
        }
      });
    });
    peer.on('error', function (e) {
      errEl.textContent = 'Could not connect (' + (e && e.type || 'error') + '). Check the session name.';
    });
    setTimeout(function () {
      if (!active && GAME.State.state === 'mp-join-form' && errEl.textContent === 'Connecting…') {
        errEl.textContent = 'No session found with that name.';
      }
    }, 8000);
  }

  function startRaceAsHost() {
    if (role !== 'host') return;
    Net.raceResults = [];
    // One absolute instant on the shared clock. The buffer covers the trip out
    // to the slowest client, so lights-out lands on every screen together.
    var startAt = netNow() + GAME.Config.net.startBufferMs + GAME.Config.race.countdownMs;
    var trackIndex = GAME.State.selectedTrackIndex;
    broadcast({ type: 'start', startAt: startAt, trackIndex: trackIndex });
    leaveLobbyToRace(startAt, trackIndex);
  }

  // ---- per-frame ------------------------------------------------------------
  function update(dt) {
    if (!active) return;
    pumpClockSync();
    var S = GAME.State;
    if (S.state === 'countdown' || S.state === 'racing' || S.state === 'finished') {
      sendAccum += dt;
      if (sendAccum >= 1 / GAME.Config.net.sendHz) { sendAccum = 0; sendState(); }
      standingsAccum += dt;
      if (standingsAccum >= GAME.Config.net.standingsInterval) {
        standingsAccum = 0;
        GAME.Hud.renderStandings();
      }
    }
  }

  function init(threeScene) {
    scene = threeScene;
    document.getElementById('createSessionBtn').addEventListener('click', createSession);
    document.getElementById('joinSessionBtn').addEventListener('click', joinSession);
    document.getElementById('lobbyStartBtn').addEventListener('click', startRaceAsHost);
    document.getElementById('lobbyLeaveBtn').addEventListener('click', function () {
      leave();
      GAME.State.state = 'mode';
      GAME.Menus.showScreen('screenMode');
    });
  }

  // ---- exports --------------------------------------------------------------
  Net.init = init;
  Net.update = update;
  Net.updateRemoteCars = updateRemoteCars;
  Net.isActive = function () { return active; };
  Net.role = function () { return role; };
  Net.sessionName = function () { return sessionName; };
  Net.netNow = netNow;
  Net.gameNow = gameNow;
  Net.currentStandings = currentStandings;
  Net.myPlace = myPlace;
  Net.reportFinish = reportFinish;
  Net.enterLobbyView = enterLobbyView;
  Net.leave = leave;
})();
