/* ===========================================================================
   game.js — scene setup, race state machine, input and the main loop
   ---------------------------------------------------------------------------
   This is the file that ties the others together. It owns GAME.State, which is
   the single shared snapshot of what is happening right now, and it decides
   when to load a track, start a countdown, count a lap or end a race.

   It deliberately contains no handling maths (physics.js), no track shapes
   (tracks.js), no mesh building (track-scene.js / scenery.js / car-model.js)
   and no networking (multiplayer.js).
   =========================================================================== */

GAME.State = {
  state: 'mode',          // mode | menu | mp-* | waiting | countdown | racing | finished
  car: null,
  track: null,            // geometry of the loaded track
  trackDef: null,         // its entry in tracks.js
  selectedTrackIndex: 0,
  selectedLiveryIndex: 0,
  selectedUnitIndex: 0,
  selectedTempUnitIndex: 0,
  lapCount: 0,
  lastLapMs: null,
  bestLapMs: null,
  bestScore: null,        // session only; resets on reload
  raceStartTime: 0,
  lapStartTime: 0,
  countdownEndTime: 0,
  progress: 0,            // monotonic distance around the circuit
  progressLap: 0,
  lastProgIdx: 0,
  lapFrac: 0,
  passedHalfway: false,
  offTrack: false
};

GAME.Game = (function () {
  'use strict';

  var S = GAME.State;
  var C = GAME.Config;

  var scene, camera, renderer, holder, ground;
  var carGroup = new THREE.Group();
  var wheelMeshes = [], frontWheelGroups = [], brakeLightMeshes = [];
  var trackCache = {};    // id -> { geom, trackGroup, sceneryGroup }
  var keys = { up: false, down: false, left: false, right: false };
  var lookBack = false;   // true while Space is held — look backward instead of the view's normal direction
  var camPos, camLook, shakeTime = 0, shakeIntensity = 0;
  var lastT = 0;

  // ---- scene ---------------------------------------------------------------
  function buildScene() {
    holder = document.getElementById('canvasHolder');
    scene = new THREE.Scene();
    scene.background = new THREE.Color(C.world.sky);
    scene.fog = new THREE.Fog(C.world.sky, C.world.fogNear, C.world.fogFar);

    camera = new THREE.PerspectiveCamera(
      C.camera.fov, holder.clientWidth / holder.clientHeight, C.camera.near, C.camera.far
    );

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(holder.clientWidth, holder.clientHeight);
    holder.insertBefore(renderer.domElement, holder.firstChild);

    window.addEventListener('resize', function () {
      var w = holder.clientWidth, h = holder.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });

    scene.add(new THREE.AmbientLight(0xffffff, C.world.ambientLight));
    var sun = new THREE.DirectionalLight(0xffffff, C.world.sunLight);
    sun.position.set(1500, 2200, 900);
    scene.add(sun);

    ground = new THREE.Mesh(
      new THREE.PlaneGeometry(C.world.groundWidth, C.world.groundDepth),
      new THREE.MeshBasicMaterial({ color: C.world.groundColor })
    );
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);

    scene.add(carGroup);
  }

  // ---- track loading -------------------------------------------------------
  // Tracks are built once and then shown/hidden, so switching back to one you
  // have already raced is instant.
  function loadTrack(index) {
    var def = GAME.Tracks[index];
    if (!def) return;
    if (S.trackDef === def) return;

    Object.keys(trackCache).forEach(function (id) {
      trackCache[id].trackGroup.visible = false;
      trackCache[id].sceneryGroup.visible = false;
    });

    var entry = trackCache[def.id];
    if (!entry) {
      var geom = GAME.TrackGeometry.create(def);
      var trackGroup = GAME.TrackScene.build(geom);
      var sceneryGroup = GAME.Scenery.build(geom);
      scene.add(trackGroup);
      scene.add(sceneryGroup);
      entry = trackCache[def.id] = { geom: geom, trackGroup: trackGroup, sceneryGroup: sceneryGroup };
    }
    entry.trackGroup.visible = true;
    entry.sceneryGroup.visible = true;

    S.trackDef = def;
    S.track = entry.geom;
    ground.position.set(entry.geom.center.x, 0, entry.geom.center.z);

    resetCarToGrid();
    snapCameraToCar();
  }

  // ---- car -----------------------------------------------------------------
  function rebuildPlayerCar() {
    while (carGroup.children.length) carGroup.remove(carGroup.children[0]);
    wheelMeshes.length = 0;
    frontWheelGroups.length = 0;
    brakeLightMeshes.length = 0;
    var built = GAME.CarModel.create(GAME.Liveries[S.selectedLiveryIndex].colors);
    while (built.group.children.length) carGroup.add(built.group.children[0]);
    built.wheelMeshes.forEach(function (w) { wheelMeshes.push(w); });
    built.frontWheelGroups.forEach(function (g) { frontWheelGroups.push(g); });
    built.brakeLights.forEach(function (b) { brakeLightMeshes.push(b); });
  }

  function resetCarToGrid() {
    if (!S.track) return;
    var slot = GAME.Net.isActive()
      ? S.track.gridSlot(GAME.Net.myGridIndex || 0)
      : S.track.soloStart();
    GAME.Physics.placeAt(S.car, slot);
    S.passedHalfway = false;
    var info = S.track.nearestTrackInfo(slot.x, slot.y);
    S.lastProgIdx = info.index;
    S.progressLap = 0;
    S.progress = info.index + info.point.t;
    S.lapFrac = (info.index + info.point.t) / S.track.N;
  }

  function resetRaceCounters() {
    S.lapCount = 0;
    S.lastLapMs = null;
    S.bestLapMs = null;
  }

  // ---- input ---------------------------------------------------------------
  function setKey(code, val) {
    if (code === 'KeyW' || code === 'ArrowUp') keys.up = val;
    else if (code === 'KeyS' || code === 'ArrowDown') keys.down = val;
    else if (code === 'KeyA' || code === 'ArrowLeft') keys.left = val;
    else if (code === 'KeyD' || code === 'ArrowRight') keys.right = val;
  }
  function isTypingTarget(el) {
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
  }
  function wireInput() {
    var driveKeys = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    window.addEventListener('keydown', function (e) {
      if (isTypingTarget(document.activeElement)) return;   // let menu forms type normally
      if (driveKeys.indexOf(e.code) !== -1) {
        e.preventDefault();
        setKey(e.code, true);
        if (S.state === 'waiting') beginCountdown();
      } else if (e.code === 'KeyR' && S.state !== 'menu' && S.state !== 'mode' && !GAME.Net.isActive()) {
        enterWaiting();
      } else if (e.code === 'KeyV') {
        GAME.Hud.toggleVehicleStatus();
      } else if (e.code === 'KeyC' && !e.repeat) {
        var mode = GAME.CameraViews.cycle();
        if (mode === 'chase') snapCameraToCar();  // avoid a big lerp jump back in
      } else if (e.code === 'Space') {
        e.preventDefault();  // don't let Space activate a focused button
        lookBack = true;
      }
    }, { passive: false });

    window.addEventListener('keyup', function (e) {
      if (isTypingTarget(document.activeElement)) return;
      setKey(e.code, false);
      if (e.code === 'Space') lookBack = false;
    });

    document.querySelectorAll('.tbtn').forEach(function (btn) {
      var k = btn.getAttribute('data-k');
      function on(v) {
        return function (ev) {
          ev.preventDefault();
          keys[k] = v;
          if (v && S.state === 'waiting') beginCountdown();
        };
      }
      btn.addEventListener('touchstart', on(true), { passive: false });
      btn.addEventListener('touchend', on(false), { passive: false });
      btn.addEventListener('mousedown', on(true));
      btn.addEventListener('mouseup', on(false));
      btn.addEventListener('mouseleave', on(false));
    });
  }

  // ---- race state machine --------------------------------------------------
  function enterWaiting() {
    loadTrack(S.selectedTrackIndex);
    S.state = 'waiting';
    GAME.Menus.showScreen('screenRace');
    rebuildPlayerCar();
    resetCarToGrid();
    snapCameraToCar();
    resetRaceCounters();
    document.getElementById('scoreBox').classList.add('hidden');
    GAME.Hud.clearNameLabels();
    GAME.Hud.renderStandings();
    GAME.Hud.hideResults();

    var ovTitle = document.getElementById('ovTitle');
    var ovSub = document.getElementById('ovSub');
    ovTitle.style.display = 'block';
    ovSub.style.display = 'block';
    document.getElementById('ovBtn').style.display = 'none';
    document.getElementById('menuBtn').style.display = 'inline-block';
    ovTitle.textContent = S.trackDef.name + ' — ' + GAME.Liveries[S.selectedLiveryIndex].name;
    ovSub.textContent = 'Press W A S D (or arrow keys) to start';
    document.getElementById('countdownNum').textContent = '';
    GAME.Hud.update(0);
  }

  // endAt, when given, is an absolute instant on the shared network clock, so
  // every machine drops the lights at the same moment.
  function beginCountdown(endAt) {
    S.state = 'countdown';
    S.countdownEndTime = (endAt === undefined || endAt === null)
      ? (GAME.Net.gameNow() + C.race.countdownMs)
      : endAt;
    document.getElementById('ovTitle').style.display = 'none';
    document.getElementById('ovSub').style.display = 'none';
    document.getElementById('menuBtn').style.display = 'none';
  }

  function startRace() {
    S.state = 'racing';
    // anchored to the scheduled instant, not to whenever this frame ran, so
    // clocks can't drift apart between machines
    S.raceStartTime = S.countdownEndTime;
    S.lapStartTime = S.raceStartTime;
    S.lapCount = 0;
    GAME.Menus.hideOverlay();
    document.getElementById('countdownNum').textContent = '';
  }

  function completeLap() {
    var now = GAME.Net.gameNow();
    S.lastLapMs = now - S.lapStartTime;
    if (S.bestLapMs === null || S.lastLapMs < S.bestLapMs) S.bestLapMs = S.lastLapMs;
    S.lapStartTime = now;
    S.lapCount++;
    S.passedHalfway = false;
    if (S.lapCount >= C.race.totalLaps) finishRace();
  }

  // Score rewards a quick total time with a bonus for a quick best lap.
  function computeScore(totalMs, bestMs) {
    var timePoints = Math.max(0, Math.round(20000 - totalMs / 12));
    var lapBonus = bestMs ? Math.max(0, Math.round(4000 - bestMs / 6)) : 0;
    return timePoints + lapBonus;
  }

  function finishRace() {
    S.state = 'finished';
    // The per-frame loop only drives GAME.Hud.update() while state === 'racing',
    // so tell it explicitly here — otherwise the race HUD stays visible,
    // floating on top of the results screen, until a menu is next opened.
    GAME.Hud.update(0);
    var total = GAME.Net.gameNow() - S.raceStartTime;
    var score = computeScore(total, S.bestLapMs);
    if (S.bestScore === null || score > S.bestScore) S.bestScore = score;

    GAME.Menus.showScreen('screenRace');
    var ovTitle = document.getElementById('ovTitle');
    var ovSub = document.getElementById('ovSub');
    ovTitle.style.display = 'block';
    ovSub.style.display = 'block';
    ovTitle.textContent = GAME.Net.isActive()
      ? 'Finished — ' + GAME.Hud.ordinal(GAME.Net.myPlace())
      : 'Finished!';
    ovSub.textContent = 'Total time ' + GAME.Hud.fmt(total) + ' — Best lap ' + GAME.Hud.fmt(S.bestLapMs);
    document.getElementById('scoreValue').textContent = 'Score: ' + score.toLocaleString();
    document.getElementById('scoreBestLine').textContent = 'Best score this session: ' + S.bestScore.toLocaleString();
    document.getElementById('scoreBox').classList.remove('hidden');
    var ovBtn = document.getElementById('ovBtn');
    ovBtn.textContent = GAME.Net.isActive() ? 'Back to Lobby' : 'Race Again';
    ovBtn.style.display = 'inline-block';
    document.getElementById('menuBtn').style.display = 'inline-block';

    if (GAME.Net.isActive()) {
      GAME.Net.reportFinish(total, S.bestLapMs);
      GAME.Hud.renderResults();
      GAME.Hud.renderStandings();
    }
  }

  function backToMainMenu() {
    if (GAME.Net.isActive()) GAME.Net.leave();
    S.state = 'mode';
    GAME.Menus.showScreen('screenMode');
  }

  // ---- per-frame race logic ------------------------------------------------
  function update(dt) {
    if (S.state !== 'racing') return;

    var T = S.track;
    var r = GAME.Physics.step(S.car, keys, T, dt);
    S.offTrack = r.offTrack;

    var halfBand = Math.round(T.N * 0.06);
    if (Math.abs(r.info.index - T.halfwayIdx) < halfBand) S.passedHalfway = true;

    // Distance travelled around the loop, counted independently of the lap
    // counter so it keeps rising cleanly across the start/finish wrap.
    if (S.lastProgIdx > T.N * 0.75 && r.info.index < T.N * 0.25) S.progressLap++;
    else if (S.lastProgIdx < T.N * 0.25 && r.info.index > T.N * 0.75) S.progressLap--;
    S.lastProgIdx = r.info.index;
    S.progress = S.progressLap * T.N + r.info.index + r.info.point.t;
    S.lapFrac = (r.info.index + r.info.point.t) / T.N;

    var crossed = GAME.TrackGeometry.segmentsIntersect(
      { x: r.prevX, y: r.prevY }, { x: S.car.x, y: S.car.y },
      { x: T.finish.x1, y: T.finish.y1 }, { x: T.finish.x2, y: T.finish.y2 }
    );
    if (crossed) {
      var movedForward = (S.car.x - r.prevX) * T.finish.ux + (S.car.y - r.prevY) * T.finish.uy;
      if (movedForward > 0 && S.passedHalfway) completeLap();
    }

    GAME.Hud.update(GAME.Net.gameNow() - S.lapStartTime);
  }

  // ---- camera --------------------------------------------------------------
  function snapCameraToCar() {
    var fx = Math.cos(S.car.angle), fz = Math.sin(S.car.angle);
    camPos = new THREE.Vector3(
      S.car.x - fx * (C.camera.distanceBehind + 5),
      C.camera.height + 6,
      S.car.y - fz * (C.camera.distanceBehind + 5)
    );
    camLook = new THREE.Vector3(S.car.x, C.camera.lookHeight, S.car.y);
  }

  function updateCamera(dt) {
    var cam = C.camera;

    // screen shake while off the tarmac — eases in and out, and scales with
    // speed so crawling on the grass barely shakes at all. Shared by every
    // view, chase or onboard, so the ride feels consistent either way.
    var shakeTarget = (S.state === 'racing' && S.offTrack) ? 1 : 0;
    shakeIntensity += (shakeTarget - shakeIntensity) * Math.min(1, dt * cam.shake.easeIn);
    shakeTime += dt * cam.shake.speed;
    var speedFactor = GAME.Physics.speedFraction(S.car);
    var amp = shakeIntensity * (0.3 + speedFactor * 0.7) * cam.shake.amplitude;
    var jx = Math.sin(shakeTime * 1.0) * amp;
    var jy = Math.sin(shakeTime * 1.37 + 1.1) * amp * 0.55;
    var jz = Math.cos(shakeTime * 0.83 + 0.6) * amp;

    if (GAME.CameraViews.isOnboard()) {
      GAME.CameraViews.applyOnboard(camera, S.car, lookBack, jx, jy, jz);
      return;
    }

    var fx = Math.cos(S.car.angle), fz = Math.sin(S.car.angle);
    var lookAhead = lookBack ? -cam.lookAhead : cam.lookAhead;   // hold Space to look behind instead of ahead
    var targetPos = new THREE.Vector3(S.car.x - fx * cam.distanceBehind, cam.height, S.car.y - fz * cam.distanceBehind);
    var targetLook = new THREE.Vector3(S.car.x + fx * lookAhead, cam.lookHeight, S.car.y + fz * lookAhead);
    var s = 1 - Math.pow(cam.followSmoothing, dt);
    camPos.lerp(targetPos, s);
    camLook.lerp(targetLook, s);

    camera.position.set(camPos.x + jx, camPos.y + jy, camPos.z + jz);
    camera.lookAt(camLook.x + jx * 0.4, camLook.y + jy * 0.4, camLook.z + jz * 0.4);
  }

  // ---- car mesh ------------------------------------------------------------
  function updateCarMesh(dt) {
    carGroup.position.set(S.car.x, 0, S.car.y);
    carGroup.rotation.y = -S.car.angle;
    var wheelSpin = S.car.vf * dt * 0.32;
    wheelMeshes.forEach(function (w) { w.rotation.y += wheelSpin; });
    frontWheelGroups.forEach(function (g) { g.rotation.y = -S.car.steer * 0.4; });

    // on whenever actually braking, or off the throttle and still rolling
    // forward (drag is slowing the car, same as lifting off in a real car)
    var braking = S.state === 'racing' && (keys.down || (!keys.up && S.car.vf > 2));
    var color = braking ? GAME.CarModel.BRAKE_ON : GAME.CarModel.BRAKE_OFF;
    brakeLightMeshes.forEach(function (b) { b.material.color.copy(color); });
  }

  // ---- main loop -----------------------------------------------------------
  function frame(now) {
    var dt = Math.min((now - lastT) / 1000, 0.05);
    lastT = now;

    if (S.state === 'countdown') {
      var remaining = S.countdownEndTime - GAME.Net.gameNow();
      if (remaining <= 0) {
        startRace();
      } else {
        // the multiplayer buffer can be longer than the countdown; the board
        // still only ever shows 3-2-1
        var n = Math.min(Math.ceil(C.race.countdownMs / 1000), Math.ceil(remaining / 1000));
        document.getElementById('countdownNum').textContent = n > 0 ? String(n) : 'GO!';
      }
    }

    update(dt);
    updateCarMesh(dt);
    GAME.Net.updateRemoteCars(dt);
    updateCamera(dt);
    renderer.render(scene, camera);
    if (S.state === 'menu') GAME.Menus.updatePreviews(dt);
    GAME.Net.update(dt);

    requestAnimationFrame(frame);
  }

  // ---- boot ----------------------------------------------------------------
  function init() {
    if (typeof THREE === 'undefined' || !window.WebGLRenderingContext) {
      document.getElementById('loadErr').style.display = 'flex';
      return;
    }
    S.car = GAME.Physics.createCar();
    buildScene();
    GAME.Hud.init(scene);
    GAME.Net.init(scene);
    loadTrack(S.selectedTrackIndex);
    rebuildPlayerCar();
    GAME.Menus.init();
    wireInput();
    GAME.Hud.update(0);
    lastT = performance.now();
    requestAnimationFrame(frame);
  }

  return {
    init: init,
    loadTrack: loadTrack,
    rebuildPlayerCar: rebuildPlayerCar,
    resetCarToGrid: resetCarToGrid,
    resetRaceCounters: resetRaceCounters,
    enterWaiting: enterWaiting,
    beginCountdown: beginCountdown,
    backToMainMenu: backToMainMenu,
    scene: function () { return scene; }
  };
})();

document.addEventListener('DOMContentLoaded', GAME.Game.init);
