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
 
  // SVG Gauge Arc lengths for Dasharray/Dashoffset calculations
  var RPM_ARC_LEN = 335.1;  // 240 deg arc at r=80
  var FUEL_ARC_LEN = 92.1;  // 80 deg arc at r=66
 
  /**
   * Builds and injects the telemetry overlay markup and CSS overlay into the DOM.
   */
  function buildTelemetryOverlay() {
    if (document.getElementById('hudTelemetryWrapper')) return;
 
    var style = document.createElement('style');
    style.id = 'hudTelemetryOverlayStyle';
    style.textContent = `
      #hudTelemetryWrapper {
        position: absolute;
        inset: 0;
        pointer-events: none;
        user-select: none;
        font-family: 'Segoe UI', -apple-system, Roboto, sans-serif;
        color: #fff;
        z-index: 1000;
        opacity: 0;
        transition: opacity 0.25s ease;
      }
      #hudTelemetryWrapper.hud-race-visible { opacity: 1; }
 
      /* ===================================================================
         1. BIRD'S-EYE CAR DIAGRAM (MIDDLE RIGHT)
         =================================================================== */
      #hudCarDiagramOverlay {
        position: absolute;
        top: 45%;
        right: 20px;
        transform: translateY(-50%) translateX(0%);
        background: rgba(12, 16, 24, 0.18);
        border: 1px solid rgba(255, 255, 255, 0.10);
        backdrop-filter: blur(6px);
        border-radius: 12px;
        padding: 14px 12px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.25);
        width: 220px;
        transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1);
      }
      #hudCarDiagramOverlay.hud-status-tucked {
        transform: translateY(-50%) translateX(160%);
      }
      .hud-diagram-title {
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 1.5px;
        text-transform: uppercase;
        color: rgba(255,255,255,0.5);
        text-align: center;
        margin-bottom: 8px;
      }
      .hud-car-schematic {
        position: relative;
        width: 100%;
        height: 180px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .hud-car-svg {
        height: 100%;
        width: auto;
        opacity: 0.85;
      }
      /* Wheel Telemetry Cards attached to corners */
      .hud-diagram-wheel {
        position: absolute;
        width: 62px;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 6px;
        padding: 4px 5px;
        font-size: 9px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.4);
      }
      .wheel-fl { top: 4px; left: 0; }
      .wheel-fr { top: 4px; right: 0; }
      .wheel-rl { bottom: 4px; left: 0; }
      .wheel-rr { bottom: 4px; right: 0; }
 
      .hud-diagram-wheel .w-title {
        font-weight: 900;
        font-size: 8px;
        color: rgba(255,255,255,0.6);
        border-bottom: 1px solid rgba(255,255,255,0.1);
        padding-bottom: 1px;
        margin-bottom: 2px;
      }
      .hud-diagram-wheel .w-row {
        display: flex;
        justify-content: space-between;
        margin-bottom: 1px;
      }
      .hud-diagram-wheel .w-lbl { color: rgba(255,255,255,0.5); }
      .hud-diagram-wheel .w-val { font-weight: 700; transition: color 0.2s; }
 
      /* ===================================================================
         2. COMBINED TELEMETRY DIAL (BOTTOM RIGHT)
         =================================================================== */
      #hudDialContainer {
        position: absolute;
        bottom: 20px;
        right: 20px;
        width: 210px;
        height: 210px;
        background: rgba(12, 16, 24, 0.18);
        border: 1px solid rgba(255, 255, 255, 0.10);
        backdrop-filter: blur(6px);
        border-radius: 50%;
        box-shadow: 0 10px 30px rgba(0,0,0,0.3);
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .hud-dial-svg {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
      }
      .hud-dial-bg-arc {
        fill: none;
        stroke: rgba(255, 255, 255, 0.1);
        stroke-width: 10;
        stroke-linecap: round;
        stroke-dasharray: 335.1 502.65;
        transform: rotate(150deg);
        transform-origin: 100px 100px;
      }
      .hud-dial-rpm-arc {
        fill: none;
        stroke: url(#rpmGradient);
        stroke-width: 10;
        stroke-linecap: round;
        stroke-dasharray: 335.1 502.65;
        stroke-dashoffset: 335.1;
        transform: rotate(150deg);
        transform-origin: 100px 100px;
        transition: stroke-dashoffset 0.05s linear;
      }
      .hud-dial-fuel-bg {
        fill: none;
        stroke: rgba(255, 255, 255, 0.1);
        stroke-width: 6;
        stroke-linecap: round;
        stroke-dasharray: 92.1 414.69;
        transform: rotate(50deg);
        transform-origin: 100px 100px;
      }
      .hud-dial-fuel-arc {
        fill: none;
        stroke: #2ae07b;
        stroke-width: 6;
        stroke-linecap: round;
        stroke-dasharray: 92.1 414.69;
        stroke-dashoffset: 0;
        transform: rotate(50deg);
        transform-origin: 100px 100px;
        transition: stroke-dashoffset 0.2s, stroke 0.2s;
      }
      .hud-dial-fuel-arc.low { stroke: #ff2a2a; }
 
      /* Center Contents of Dial */
      .hud-dial-center {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        z-index: 2;
        margin-top: -4px;
      }
      .hud-dial-gear-box {
        width: 46px;
        height: 46px;
        background: rgba(255, 255, 255, 0.06);
        border: 2px solid rgba(255, 255, 255, 0.25);
        border-radius: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-bottom: 2px;
        transition: border-color 0.1s, background-color 0.1s;
      }
      .hud-dial-gear-box.shift-light {
        border-color: #ff2a2a;
        background: rgba(255, 42, 42, 0.45);
        animation: dialShiftBlink 0.1s infinite alternate;
      }
      @keyframes dialShiftBlink {
        from { opacity: 1; }
        to { opacity: 0.4; }
      }
      .hud-dial-gear-val {
        font-size: 30px;
        font-weight: 900;
        line-height: 1;
        color: #fff;
      }
      .hud-dial-speed-val {
        font-size: 26px;
        font-weight: 900;
        line-height: 1;
        letter-spacing: -0.5px;
      }
      .hud-dial-speed-unit {
        font-size: 9px;
        font-weight: 800;
        color: rgba(255,255,255,0.5);
        margin-left: 2px;
      }
      .hud-dial-rpm-text {
        font-size: 10px;
        font-weight: 800;
        color: rgba(255,255,255,0.7);
        margin-top: 2px;
      }
      .hud-dial-fuel-lbl {
        font-size: 8px;
        font-weight: 800;
        color: rgba(255,255,255,0.5);
        margin-top: 6px;
        letter-spacing: 0.5px;
      }
    `;
    document.head.appendChild(style);
 
    // Inject Overlay HTML
    var wrapper = document.createElement('div');
    wrapper.id = 'hudTelemetryWrapper';
    wrapper.innerHTML = `
      <!-- Middle Right: Bird's Eye View Car Diagram -->
      <div id="hudCarDiagramOverlay">
        <div class="hud-diagram-title">Vehicle Status</div>
        <div class="hud-car-schematic">
          <svg class="hud-car-svg" viewBox="0 0 100 180">
            <path d="M50,12 L58,35 L61,70 L64,115 L59,152 L50,166 L41,152 L36,115 L39,70 L42,35 Z"
                  fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.3)" stroke-width="2"/>
            <rect x="22" y="16" width="56" height="7" rx="2" fill="rgba(255,255,255,0.2)"/>
            <rect x="18" y="152" width="64" height="10" rx="2" fill="rgba(255,255,255,0.2)"/>
            <rect x="18" y="32" width="11" height="22" rx="3" fill="rgba(255,255,255,0.25)"/>
            <rect x="71" y="32" width="11" height="22" rx="3" fill="rgba(255,255,255,0.25)"/>
            <rect x="16" y="124" width="13" height="26" rx="3" fill="rgba(255,255,255,0.25)"/>
            <rect x="71" y="124" width="13" height="26" rx="3" fill="rgba(255,255,255,0.25)"/>
          </svg>
 
          <!-- Front Left -->
          <div class="hud-diagram-wheel wheel-fl" id="hudWheel0">
            <div class="w-title">FRONT L</div>
            <div class="w-row"><span class="w-lbl">Tire</span><span class="w-val" id="hudTemp0">75°C</span></div>
            <div class="w-row"><span class="w-lbl">Brk</span><span class="w-val" id="hudBrake0">40°C</span></div>
            <div class="w-row"><span class="w-lbl">Wear</span><span class="w-val" id="hudWear0">0%</span></div>
          </div>
          <!-- Front Right -->
          <div class="hud-diagram-wheel wheel-fr" id="hudWheel1">
            <div class="w-title">FRONT R</div>
            <div class="w-row"><span class="w-lbl">Tire</span><span class="w-val" id="hudTemp1">75°C</span></div>
            <div class="w-row"><span class="w-lbl">Brk</span><span class="w-val" id="hudBrake1">40°C</span></div>
            <div class="w-row"><span class="w-lbl">Wear</span><span class="w-val" id="hudWear1">0%</span></div>
          </div>
          <!-- Rear Left -->
          <div class="hud-diagram-wheel wheel-rl" id="hudWheel2">
            <div class="w-title">REAR L</div>
            <div class="w-row"><span class="w-lbl">Tire</span><span class="w-val" id="hudTemp2">75°C</span></div>
            <div class="w-row"><span class="w-lbl">Brk</span><span class="w-val" id="hudBrake2">35°C</span></div>
            <div class="w-row"><span class="w-lbl">Wear</span><span class="w-val" id="hudWear2">0%</span></div>
          </div>
          <!-- Rear Right -->
          <div class="hud-diagram-wheel wheel-rr" id="hudWheel3">
            <div class="w-title">REAR R</div>
            <div class="w-row"><span class="w-lbl">Tire</span><span class="w-val" id="hudTemp3">75°C</span></div>
            <div class="w-row"><span class="w-lbl">Brk</span><span class="w-val" id="hudBrake3">35°C</span></div>
            <div class="w-row"><span class="w-lbl">Wear</span><span class="w-val" id="hudWear3">0%</span></div>
          </div>
        </div>
      </div>
 
      <!-- Bottom Right: Integrated Circular Telemetry Dial -->
      <div id="hudDialContainer">
        <svg class="hud-dial-svg" viewBox="0 0 200 200">
          <defs>
            <linearGradient id="rpmGradient" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#2ae07b" />
              <stop offset="65%" stop-color="#e6ca65" />
              <stop offset="100%" stop-color="#ff2a2a" />
            </linearGradient>
          </defs>
          <circle class="hud-dial-bg-arc" cx="100" cy="100" r="80" />
          <circle class="hud-dial-rpm-arc" id="hudRpmArc" cx="100" cy="100" r="80" />
          <circle class="hud-dial-fuel-bg" cx="100" cy="100" r="66" />
          <circle class="hud-dial-fuel-arc" id="hudFuelArc" cx="100" cy="100" r="66" />
        </svg>
 
        <div class="hud-dial-center">
          <div class="hud-dial-gear-box" id="hudGearBox">
            <span class="hud-dial-gear-val" id="hudGearVal">1</span>
          </div>
          <div>
            <span class="hud-dial-speed-val" id="hudSpeedVal">0</span>
            <span class="hud-dial-speed-unit" id="hudDialUnitLabel">KM/H</span>
          </div>
          <div class="hud-dial-rpm-text"><span id="hudRpmVal">0</span> RPM</div>
          <div class="hud-dial-fuel-lbl">FUEL <span id="hudFuelVal">100%</span></div>
        </div>
      </div>
    `;
    document.body.appendChild(wrapper);
  }
 
  function init(threeScene) {
    scene = threeScene;
    el = {
      lapCount: document.getElementById('lapCount'),
      lapBarFill: document.getElementById('lapBarFill'),
      curTime: document.getElementById('curTime'),
      lastLap: document.getElementById('lastLap'),
      bestLap: document.getElementById('bestLap'),
      standings: document.getElementById('standings'),
      standingsList: document.getElementById('standingsList'),
      posBlock: document.getElementById('posBlock'),
      posValue: document.getElementById('posValue'),
      resultsBox: document.getElementById('resultsBox'),
      resultsList: document.getElementById('resultsList')
    };
 
    buildTelemetryOverlay();
 
    // Cache Telemetry DOM Elements
    el.hudGearBox = document.getElementById('hudGearBox');
    el.hudGearVal = document.getElementById('hudGearVal');
    el.hudSpeedVal = document.getElementById('hudSpeedVal');
    el.hudDialUnitLabel = document.getElementById('hudDialUnitLabel');
    el.hudRpmVal = document.getElementById('hudRpmVal');
    el.hudRpmArc = document.getElementById('hudRpmArc');
    el.hudFuelArc = document.getElementById('hudFuelArc');
    el.hudFuelVal = document.getElementById('hudFuelVal');
 
    el.wheels = [];
    for (var i = 0; i < 4; i++) {
      el.wheels.push({
        temp: document.getElementById('hudTemp' + i),
        brake: document.getElementById('hudBrake' + i),
        wear: document.getElementById('hudWear' + i)
      });
    }

    el.hudTopLeft = document.getElementById('hudTopLeft');
    el.hudTelemetryWrapper = document.getElementById('hudTelemetryWrapper');
    el.hudCarDiagramOverlay = document.getElementById('hudCarDiagramOverlay');
  }

  // ---- vehicle status panel: tuck away off the right edge on demand ----------
  var statusTucked = false;
  function toggleVehicleStatus() {
    statusTucked = !statusTucked;
    if (el.hudCarDiagramOverlay) el.hudCarDiagramOverlay.classList.toggle('hud-status-tucked', statusTucked);
  }

  // ---- race-only visibility --------------------------------------------------
  // The lap/time card (top-left) and the telemetry dial + wheel-status card
  // (bottom-right) should only be on screen once a race is actually running —
  // not in menus, the lobby, the countdown, or the post-race results screen
  // (which the telemetry card would otherwise float on top of).
  // GAME.Hud.update() is only ever called on a 'racing' frame or at specific
  // non-racing transition points (waiting screen, boot, menu option changes),
  // so checking the state here whenever update() runs is enough to stay in
  // sync without needing extra hooks elsewhere.
  function updateRaceVisibility() {
    var show = GAME.State.state === 'racing';
    if (el.hudTopLeft) el.hudTopLeft.classList.toggle('hud-race-visible', show);
    if (el.hudTelemetryWrapper) el.hudTelemetryWrapper.classList.toggle('hud-race-visible', show);
  }
 
  // ---- formatting helpers ---------------------------------------------------
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
 
  // Thresholds are always in raw Celsius (matching physics.js's tuning),
  // regardless of which unit is currently displayed.
  function getTempColor(temp) {
    if (temp < 55) return '#4da6ff';   // Cold (Blue) — below the tyre's working window
    if (temp <= 135) return '#2ae07b'; // Working window (Green) — optimal ~95°C, hard braking can push it toward ~120°C
    if (temp <= 155) return '#e6ca65'; // Hot (Yellow) — grip and wear start to suffer
    return '#ff2a2a';                  // Overheating (Red)
  }
 
  function getBrakeColor(temp) {
    if (temp < 300) return '#ffffff';  // Cold — hasn't reached the sweet spot yet
    if (temp <= 500) return '#2ae07b'; // Sweet spot (Green) — brakes bite ~20% harder here
    if (temp <= 800) return '#e6ca65'; // Hot (Yellow) — heading toward fade
    return '#ff2a2a';                  // Fading (Red) — thermal fade kicks in near 1000°C
  }
 
  // ---- main HUD & physics telemetry update -----------------------------------
  function update(curLapMs) {
    updateRaceVisibility();

    var S = GAME.State;
    var laps = GAME.Config.race.totalLaps;
    if (el.lapCount) el.lapCount.textContent = Math.min(S.lapCount + 1, laps) + ' / ' + laps;
    if (el.lapBarFill) el.lapBarFill.style.width = Math.round(GAME.Physics.clamp(S.lapFrac, 0, 1) * 100) + '%';
    if (el.curTime) el.curTime.textContent = fmt(curLapMs);
    if (el.lastLap) el.lastLap.textContent = fmt(S.lastLapMs);
    if (el.bestLap) el.bestLap.textContent = fmt(S.bestLapMs);
 
    var car = S.car;
    if (!car) return;
 
    // Speedometer Display inside Bottom-Right Dial
    var unit = GAME.Config.units[S.selectedUnitIndex];
    var kmh = GAME.Physics.speedKmh(car);
    var speedDisplayVal = Math.round(unit.mph ? kmh * 0.621371 : kmh);
    if (el.hudSpeedVal) el.hudSpeedVal.textContent = speedDisplayVal;
 
    // =========================================================================
    // PHYSICS & THERMAL TELEMETRY VISUALIZATION
    // =========================================================================
    var telem = car.telemetry || {};
    var tuning = GAME.Physics.tuning || {};
 
    // 1. Dial Tachometer & Shift Light
    var rpm = telem.rpm || car.rpm || 1200;
    var redline = (tuning.engine && tuning.engine.redlineRpm) || 12000;
    var rpmFrac = GAME.Physics.clamp(rpm / redline, 0, 1);
 
    if (el.hudRpmVal) el.hudRpmVal.textContent = Math.round(rpm);
    if (el.hudRpmArc) {
      var rpmOffset = RPM_ARC_LEN * (1 - rpmFrac);
      el.hudRpmArc.style.strokeDashoffset = rpmOffset.toFixed(1);
    }
 
    var gear = telem.gear !== undefined ? telem.gear : car.gear;
    var gearText = gear === -1 ? 'R' : gear === 0 ? 'N' : String(gear);
    if (el.hudGearVal) el.hudGearVal.textContent = gearText;
 
    // Trigger Shift Light above 93% redline
    var isShiftLight = rpmFrac > 0.93;
    if (el.hudGearBox) el.hudGearBox.classList.toggle('shift-light', isShiftLight);
 
    // =========================================================================
    // 2. WHEEL THERMAL & WEAR READOUT (FL, FR, RL, RR)
    // =========================================================================
    // These numbers are not recomputed here — they come straight from the
    // physics step's telemetry (car.telemetry), so what's on screen always
    // matches what the tyres and brakes are actually doing in the simulation:
    // brakes can climb toward ~1000°C under hard stops and bite hardest in
    // the 300-500°C sweet spot, and hard braking can push tyres up toward
    // ~120°C (not every time — it depends on how much heat is going in).
    var tireTempsC = telem.tireTemp || [95, 95, 95, 95];
    var brakeTempsC = telem.brakeTemp || [40, 40, 35, 35];
    var tireWear = telem.tireWear || [0, 0, 0, 0];
 
    for (var w = 0; w < 4; w++) {
      if (el.wheels[w]) {
        var tTempC = tireTempsC[w];
        var bTempC = brakeTempsC[w];
        var tWear = tireWear[w];
 
        el.wheels[w].temp.textContent = GAME.Physics.formatTemp(tTempC);
        el.wheels[w].temp.style.color = getTempColor(tTempC);
 
        el.wheels[w].brake.textContent = GAME.Physics.formatTemp(bTempC);
        el.wheels[w].brake.style.color = getBrakeColor(bTempC);
 
        el.wheels[w].wear.textContent = (tWear * 100).toFixed(1) + '%';
        el.wheels[w].wear.style.color = tWear > 0.5 ? '#ff2a2a' : '#ffffff';
      }
    }
 
    // 3. Dial Fuel Arc
    var fuelCurrent = telem.fuel !== undefined ? telem.fuel : car.fuel;
    var fuelCapacity = (tuning.fuel && tuning.fuel.capacityL) || 110;
    var fuelFrac = GAME.Physics.clamp(fuelCurrent / fuelCapacity, 0, 1);
 
    if (el.hudFuelArc) {
      var fuelOffset = FUEL_ARC_LEN * (1 - fuelFrac);
      el.hudFuelArc.style.strokeDashoffset = fuelOffset.toFixed(1);
      el.hudFuelArc.classList.toggle('low', fuelFrac < 0.15);
    }
    if (el.hudFuelVal) {
      el.hudFuelVal.textContent = (fuelFrac * 100).toFixed(0) + '%';
    }
  }
 
  function setUnitLabel(name) { 
    if (el.hudDialUnitLabel) el.hudDialUnitLabel.textContent = name.toUpperCase(); 
  }
 
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
  var nameLabels = {};
 
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
    refreshNameLabels: refreshNameLabels, updateNameLabels: updateNameLabels,
    toggleVehicleStatus: toggleVehicleStatus
  };
})();
