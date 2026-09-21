/* ===========================================================================
   menus.js — every screen in the overlay
   ---------------------------------------------------------------------------
   Builds the track, livery and unit pickers from the data in tracks.js,
   liveries.js and config.js, and handles moving between screens.

   Adding a track or livery needs no change here — the lists build themselves.
   =========================================================================== */

GAME.Menus = (function () {
  'use strict';

  var ALL_SCREENS = [
    'screenMode', 'screenMenu', 'screenMultiplayer',
    'screenHostForm', 'screenJoinForm', 'screenLobby', 'screenRace'
  ];

  var overlay = null;
  var previewInstances = [];

  function showScreen(id) {
    ALL_SCREENS.forEach(function (s) {
      document.getElementById(s).classList.toggle('hidden', s !== id);
    });
    overlay.classList.remove('hidden');
  }
  function hideOverlay() { overlay.classList.add('hidden'); }

  // ---- small spinning 3D preview of a car, one per livery option ------------
  function createCarPreview(canvas, colors) {
    var w = canvas.width, h = canvas.height;
    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    var pscene = new THREE.Scene();
    var pcam = new THREE.PerspectiveCamera(30, w / h, 1, 2000);
    pcam.position.set(92, 52, 78);
    pcam.lookAt(0, 6, 0);
    pscene.add(new THREE.AmbientLight(0xffffff, 0.9));
    var dl = new THREE.DirectionalLight(0xffffff, 0.7);
    dl.position.set(80, 120, 60);
    pscene.add(dl);
    var built = GAME.CarModel.create(colors);
    built.group.rotation.y = 0.5;
    pscene.add(built.group);
    return { renderer: renderer, scene: pscene, camera: pcam, group: built.group };
  }
  function updatePreviews(dt) {
    previewInstances.forEach(function (p) {
      p.group.rotation.y += dt * 0.6;
      p.renderer.render(p.scene, p.camera);
    });
  }

  // ---- option lists ---------------------------------------------------------
  function buildTrackMenu() {
    var container = document.getElementById('trackOptions');
    container.innerHTML = '';
    GAME.Tracks.forEach(function (item, i) {
      var el = document.createElement('div');
      el.className = 'menu-opt' + (item.available === false ? ' disabled' : '');
      el.innerHTML = GAME.Hud.escapeHtml(item.name) +
        '<span class="tag">' + (item.available === false ? 'Coming soon' : GAME.Hud.escapeHtml(item.place || '')) + '</span>';
      if (item.available !== false) {
        el.addEventListener('click', function () {
          GAME.State.selectedTrackIndex = i;
          updateSelectionClasses();
        });
      }
      container.appendChild(el);
    });
  }

  function buildLiveryMenu() {
    var container = document.getElementById('liveryOptions');
    container.innerHTML = '';
    previewInstances = [];
    GAME.Liveries.forEach(function (item, i) {
      var el = document.createElement('div');
      el.className = 'menu-opt livery-opt' + (item.available === false ? ' disabled' : '');
      var canvas = document.createElement('canvas');
      canvas.className = 'livery-canvas';
      canvas.width = 180;
      canvas.height = 68;
      el.appendChild(canvas);
      var label = document.createElement('div');
      label.className = 'livery-name';
      label.textContent = item.name + (item.available === false ? ' (coming soon)' : '');
      el.appendChild(label);
      if (item.available !== false) {
        el.addEventListener('click', function () {
          GAME.State.selectedLiveryIndex = i;
          updateSelectionClasses();
        });
        previewInstances.push(createCarPreview(canvas, item.colors));
      }
      container.appendChild(el);
    });
  }

  function buildUnitMenu() {
    var container = document.getElementById('unitOptions');
    container.innerHTML = '';
    GAME.Config.units.forEach(function (item, i) {
      var el = document.createElement('div');
      el.className = 'menu-opt';
      el.textContent = item.name;
      el.addEventListener('click', function () {
        GAME.State.selectedUnitIndex = i;
        updateSelectionClasses();
        refreshHud();
      });
      container.appendChild(el);
    });
  }

  function buildTempUnitMenu() {
    var container = document.getElementById('tempUnitOptions');
    container.innerHTML = '';
    GAME.Config.tempUnits.forEach(function (item, i) {
      var el = document.createElement('div');
      el.className = 'menu-opt';
      el.textContent = item.name;
      el.addEventListener('click', function () {
        GAME.State.selectedTempUnitIndex = i;
        GAME.Physics.setTempUnit(item.id);
        updateSelectionClasses();
        refreshHud();
      });
      container.appendChild(el);
    });
  }

  function updateSelectionClasses() {
    var S = GAME.State;
    document.querySelectorAll('#trackOptions .menu-opt').forEach(function (el, i) {
      el.classList.toggle('selected', i === S.selectedTrackIndex);
    });
    document.querySelectorAll('#liveryOptions .menu-opt').forEach(function (el, i) {
      el.classList.toggle('selected', i === S.selectedLiveryIndex);
    });
    document.querySelectorAll('#unitOptions .menu-opt').forEach(function (el, i) {
      el.classList.toggle('selected', i === S.selectedUnitIndex);
    });
    document.querySelectorAll('#tempUnitOptions .menu-opt').forEach(function (el, i) {
      el.classList.toggle('selected', i === S.selectedTempUnitIndex);
    });
    GAME.Hud.setUnitLabel(GAME.Config.units[S.selectedUnitIndex].name);
    GAME.Game.rebuildPlayerCar();
  }

  // GAME.Hud.update() is otherwise only driven by the race loop while
  // S.state === 'racing', so without this, toggling a unit here (e.g.
  // tyre/brake temp C/F) wouldn't show up until a race actually starts.
  // Called only from the option click handlers below — never from init(),
  // so it can't interfere with first-load setup.
  function refreshHud() {
    if (GAME.State.car) GAME.Hud.update(0);
  }

  // ---- navigation -----------------------------------------------------------
  function wireNavigation() {
    document.getElementById('spModeBtn').addEventListener('click', function () {
      GAME.State.state = 'menu';
      showScreen('screenMenu');
    });
    document.getElementById('spBackBtn').addEventListener('click', function () {
      GAME.State.state = 'mode';
      showScreen('screenMode');
    });
    document.getElementById('mpModeBtn').addEventListener('click', function () {
      if (typeof Peer === 'undefined') {
        alert("Multiplayer needs its networking library, which didn't load (likely no internet connection right now).");
        return;
      }
      GAME.State.state = 'mp-menu';
      showScreen('screenMultiplayer');
    });
    document.getElementById('mpBackBtn').addEventListener('click', function () {
      GAME.State.state = 'mode';
      showScreen('screenMode');
    });
    document.getElementById('hostChooseBtn').addEventListener('click', function () {
      GAME.State.state = 'mp-host-form';
      document.getElementById('hostError').textContent = '';
      showScreen('screenHostForm');
    });
    document.getElementById('joinChooseBtn').addEventListener('click', function () {
      GAME.State.state = 'mp-join-form';
      document.getElementById('joinError').textContent = '';
      showScreen('screenJoinForm');
    });
    document.getElementById('hostBackBtn').addEventListener('click', function () {
      GAME.State.state = 'mp-menu';
      showScreen('screenMultiplayer');
    });
    document.getElementById('joinBackBtn').addEventListener('click', function () {
      GAME.State.state = 'mp-menu';
      showScreen('screenMultiplayer');
    });
    document.getElementById('startRaceBtn').addEventListener('click', function () {
      GAME.Game.enterWaiting();
    });
    document.getElementById('menuBtn').addEventListener('click', function () {
      GAME.Game.backToMainMenu();
    });
    document.getElementById('ovBtn').addEventListener('click', function () {
      if (GAME.Net.isActive()) GAME.Net.enterLobbyView();
      else GAME.Game.enterWaiting();
    });
  }

  function init() {
    overlay = document.getElementById('overlay');
    buildTrackMenu();
    buildLiveryMenu();
    buildUnitMenu();
    buildTempUnitMenu();
    updateSelectionClasses();
    wireNavigation();
    showScreen('screenMode');
  }

  return {
    init: init,
    showScreen: showScreen,
    hideOverlay: hideOverlay,
    updatePreviews: updatePreviews,
    updateSelectionClasses: updateSelectionClasses
  };
})();
