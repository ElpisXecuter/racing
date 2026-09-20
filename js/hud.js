/* ===========================================================================
   hud.js — everything drawn over the track
   ---------------------------------------------------------------------------
   Lap counter, lap bar, times, speedometer, live positions panel, final
   classification, and the floating name labels above cars in multiplayer.

   The markup these functions write into lives in index.html and its styling
   in css/style.css.
   =========================================================================== */

GAME.Hud = (function () {
  'use strict';

  var scene = null;
  var el = {};

  function init(threeScene) {
    scene = threeScene;
    el = {
      lapCount: document.getElementById('lapCount'),
      lapBarFill: document.getElementById('lapBarFill'),
      curTime: document.getElementById('curTime'),
      lastLap: document.getElementById('lastLap'),
      bestLap: document.getElementById('bestLap'),
      speedValue: document.getElementById('speedValue'),
      speedUnit: document.getElementById('speedUnitLabel'),
      standings: document.getElementById('standings'),
      standingsList: document.getElementById('standingsList'),
      posBlock: document.getElementById('posBlock'),
      posValue: document.getElementById('posValue'),
      resultsBox: document.getElementById('resultsBox'),
      resultsList: document.getElementById('resultsList')
    };
  }

  // ---- formatting -----------------------------------------------------------
  function fmt(ms) {
    if (ms === null || ms === undefined) return '--';
    var totalSec = ms / 1000;
    var m = Math.floor(totalSec / 60);
    var s = totalSec - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
  }
  function ordinal(n) {
    var s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ---- main readouts --------------------------------------------------------
  function update(curLapMs) {
    var S = GAME.State;
    var laps = GAME.Config.race.totalLaps;
    el.lapCount.textContent = Math.min(S.lapCount + 1, laps) + ' / ' + laps;
    el.lapBarFill.style.width = Math.round(GAME.Physics.clamp(S.lapFrac, 0, 1) * 100) + '%';
    el.curTime.textContent = fmt(curLapMs);
    el.lastLap.textContent = fmt(S.lastLapMs);
    el.bestLap.textContent = fmt(S.bestLapMs);

    var unit = GAME.Config.units[S.selectedUnitIndex];
    var kmh = GAME.Physics.speedKmh(S.car);
    el.speedValue.textContent = Math.round(unit.mph ? kmh * 0.621371 : kmh);
  }

  function setUnitLabel(name) { el.speedUnit.textContent = name; }

  // ---- live positions -------------------------------------------------------
  function renderStandings() {
    if (!el.standings) return;
    var S = GAME.State;
    var show = GAME.Net.isActive() &&
      (S.state === 'countdown' || S.state === 'racing' || S.state === 'finished');
    el.standings.classList.toggle('hidden', !show);
    if (el.posBlock) el.posBlock.style.display = show ? 'block' : 'none';
    if (!show) return;

    var list = GAME.Net.currentStandings();
    var html = '';
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var detail = (e.totalMs !== null && e.totalMs !== undefined)
        ? fmt(e.totalMs)
        : ('L' + Math.min(e.lap + 1, GAME.Config.race.totalLaps));
      html += '<div class="standing-row' + (e.me ? ' me' : '') + '">' +
        '<span class="st-pos">' + (i + 1) + '</span>' +
        '<span class="st-name">' + escapeHtml(e.name) + '</span>' +
        '<span class="st-detail">' + detail + '</span>' +
        '</div>';
      if (e.me && el.posValue) el.posValue.textContent = ordinal(i + 1) + ' / ' + list.length;
    }
    el.standingsList.innerHTML = html;
  }

  // ---- final classification -------------------------------------------------
  function renderResults() {
    if (!el.resultsBox || !el.resultsList) return;
    var S = GAME.State;
    var results = GAME.Net.raceResults;
    if (!GAME.Net.isActive() || S.state !== 'finished' || !results.length) {
      el.resultsBox.classList.add('hidden');
      return;
    }
    var html = '', mine = null;
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      if (r.id === GAME.Net.myPlayerId) mine = r;
      html += '<div class="standing-row' + (r.id === GAME.Net.myPlayerId ? ' me' : '') + '">' +
        '<span class="st-pos">' + r.place + '</span>' +
        '<span class="st-name">' + escapeHtml(r.name) + '</span>' +
        '<span class="st-detail">' + fmt(r.totalMs) + '</span>' +
        '</div>';
    }
    el.resultsList.innerHTML = html;
    el.resultsBox.classList.remove('hidden');
    if (mine) document.getElementById('ovTitle').textContent = 'Finished — ' + ordinal(mine.place);
  }
  function hideResults() {
    if (el.resultsBox) el.resultsBox.classList.add('hidden');
  }

  // ---- floating name labels -------------------------------------------------
  var nameLabels = {};   // key -> THREE.Sprite ('__me' for the local car)

  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
  function makeNameLabel(text) {
    var W = 512, H = 128;
    var canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    ctx.font = 'bold 60px "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var tw = Math.min(W - 70, ctx.measureText(text).width);
    var bw = tw + 56, bh = 84;
    var bx = (W - bw) / 2, by = (H - bh) / 2;
    ctx.fillStyle = 'rgba(8,12,18,0.42)';
    roundRectPath(ctx, bx, by, bw, bh, 26); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 3;
    roundRectPath(ctx, bx, by, bw, bh, 26); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fillText(text, W / 2, H / 2 + 2);

    var tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    // drawn on top of the world so a grandstand never eats a name
    var cfg = GAME.Config.labels;
    var mat = new THREE.SpriteMaterial({
      map: tex, transparent: true, opacity: cfg.opacity,
      depthTest: false, depthWrite: false
    });
    var sp = new THREE.Sprite(mat);
    sp.scale.set(cfg.scale[0], cfg.scale[1], 1);
    sp.renderOrder = 999;
    return sp;
  }
  function setNameLabel(key, text) {
    var old = nameLabels[key];
    if (old) {
      scene.remove(old);
      if (old.material.map) old.material.map.dispose();
      old.material.dispose();
      delete nameLabels[key];
    }
    if (!text) return;
    var sp = makeNameLabel(String(text).slice(0, 16));
    scene.add(sp);
    nameLabels[key] = sp;
  }
  function clearNameLabels() {
    Object.keys(nameLabels).forEach(function (k) { setNameLabel(k, null); });
  }
  function refreshNameLabels() {
    clearNameLabels();
    if (!GAME.Net.isActive()) return;
    setNameLabel('__me', GAME.Net.myPlayerName);
    Object.keys(GAME.Net.players).forEach(function (pid) {
      if (pid === GAME.Net.myPlayerId) return;
      setNameLabel(pid, GAME.Net.players[pid].name);
    });
  }
  function updateNameLabels() {
    var h = GAME.Config.labels.height;
    var me = nameLabels['__me'];
    if (me) me.position.set(GAME.State.car.x, h, GAME.State.car.y);
    var remotes = GAME.Net.remoteCars;
    Object.keys(remotes).forEach(function (pid) {
      var sp = nameLabels[pid];
      if (sp) sp.position.set(remotes[pid].current.x, h, remotes[pid].current.y);
    });
  }

  return {
    init: init,
    fmt: fmt, ordinal: ordinal, escapeHtml: escapeHtml,
    update: update, setUnitLabel: setUnitLabel,
    renderStandings: renderStandings,
    renderResults: renderResults, hideResults: hideResults,
    setNameLabel: setNameLabel, clearNameLabels: clearNameLabels,
    refreshNameLabels: refreshNameLabels, updateNameLabels: updateNameLabels
  };
})();
