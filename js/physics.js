/* ===========================================================================
   physics.js — the vehicle physics engine
   ---------------------------------------------------------------------------
   A proper (if simplified) vehicle-dynamics simulation: four independent
   wheels with a combined-slip ("friction circle") tyre model, an engine and
   automatic gearbox, a limited-slip differential, longitudinal + lateral
   weight transfer, aerodynamic drag and downforce, rolling resistance,
   per-surface grip, tyre heating/wear, driver assists (ABS / traction
   control / stability control), fuel load, and an impulse-based barrier
   collision response. It integrates on a fixed sub-step so it stays stable
   even on a slow or hitching frame.

   Everything that affects handling lives in `tuning` below, grouped by
   subsystem. Change a number and the whole car changes; nothing else needs
   editing. Call GAME.Physics.refresh() after changing tuning at runtime.

   ---------------------------------------------------------------------------
   PUBLIC API (this is what the rest of the game calls — keep it stable):
     tuning, derived, refresh()
     clamp(v, lo, hi)
     createCar()                          -> a fresh car state
     placeAt(car, slot)                   -> put a car on a grid/start slot
     step(car, keys, track, dt)           -> advance one frame, returns
                                              { info, prevX, prevY, offTrack }
     speedKmh(car), speedFraction(car)

   EXTENSIBILITY (for anything added later — weather, opponents, damage,
   telemetry overlays, replay systems, new terrain, etc.):
     registerExtension(fn)     fn(car, track, dt) is called once per frame,
                                after the physics step, before anything reads
                                the result. Use it to layer new behaviour
                                (tyre wear readouts, damage models, AI cars)
                                without touching the core simulation.
     on(event, fn) / off(...)  subscribe to 'wallHit', 'wheelLock',
                                'wheelSpin', 'gearShift', 'lowFuel'
     registerSurfaceSet(name, defs)   add a whole alternate surface table
                                       (e.g. 'wet', 'snow', 'lowGrav') and
                                       select it per-track via
                                       trackDef.surfaceSet = 'wet'
     setWeatherGrip(mul)       global grip multiplier, e.g. 0.6 for rain
     resolveCarCollision(a,b)  car-vs-car impulse response, ready for future
                                AI or multiplayer-local collision use
     car.telemetry             per-wheel loads/slip/temperature/wear, rpm,
                                gear — read-only diagnostic snapshot updated
                                every step, for a future dashboard/HUD
   =========================================================================== */

GAME.Physics = (function () {
  'use strict';

  // =========================================================================
  // 0. small math helpers
  // =========================================================================
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function sign(v) { return v > 0 ? 1 : (v < 0 ? -1 : 0); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function deg2rad(d) { return d * Math.PI / 180; }
  function safeNum(v, fallback) { return (typeof v === 'number' && isFinite(v)) ? v : fallback; }

  // "Magic Formula"-style curve: rises smoothly from 0, peaks at D, then eases
  // off. Used for both the longitudinal (slip ratio) and lateral (slip angle)
  // tyre force curves — same shape, different inputs and coefficients.
  function pacejka(slip, B, C, D, E) {
    var Bx = B * slip;
    return D * Math.sin(C * Math.atan(Bx - E * (Bx - Math.atan(Bx))));
  }

  // Combines longitudinal and lateral tyre demand onto one friction circle so
  // a wheel can never produce more total grip than muEff*Fz, whichever
  // direction it's asked to work in — this is what makes trail-braking into a
  // corner, or flooring it mid-corner, cost you the corner.
  function combinedTireForce(kappa, alpha, Fz, muEff, tp) {
    var cap = Math.max(muEff * Fz, 1e-4);
    var Fx0 = pacejka(kappa, tp.longB, tp.longC, cap, tp.longE);
    var Fy0 = pacejka(alpha, tp.latB, tp.latC, cap, tp.latE);
    var fxN = Fx0 / cap, fyN = Fy0 / cap;
    var mag = Math.hypot(fxN, fyN);
    if (mag > 1) { fxN /= mag; fyN /= mag; }
    return { Fx: fxN * cap, Fy: fyN * cap };
  }

  function interpCurve(curve, x) {
    if (x <= curve[0].rpm) return curve[0].torque;
    for (var i = 1; i < curve.length; i++) {
      if (x <= curve[i].rpm) {
        var t = (x - curve[i - 1].rpm) / (curve[i].rpm - curve[i - 1].rpm || 1);
        return lerp(curve[i - 1].torque, curve[i].torque, t);
      }
    }
    return curve[curve.length - 1].torque;
  }

  // =========================================================================
  // 1. surfaces — pluggable per-zone grip/rolling-resistance/roughness
  // =========================================================================
  var SURFACE_SETS = {
    default: {
      tarmac: { muMul: 1.00, rollMul: 1.0, bumpiness: 0.00 },
      curb: { muMul: 0.88, rollMul: 1.2, bumpiness: 0.45 },
      runoff: { muMul: 0.55, rollMul: 1.9, bumpiness: 0.18 },
      gravel: { muMul: 0.35, rollMul: 2.6, bumpiness: 0.30 }
    }
  };
  function registerSurfaceSet(name, defs) { SURFACE_SETS[name] = defs; }
  function surfaceSetFor(track) {
    var name = track && track.def && track.def.surfaceSet;
    return (name && SURFACE_SETS[name]) || SURFACE_SETS.default;
  }
  // Which zone a point on/near the track falls into, using the boundaries
  // track-geometry.js already computes (HALF_WIDTH/CURB_HW/RUNOFF_HW/BARRIER_HW).
  function surfaceZone(track, d) {
    if (d <= track.HALF_WIDTH) return 'tarmac';
    if (d <= track.CURB_HW) return 'curb';
    if (d <= track.RUNOFF_HW) return 'runoff';
    return 'gravel';
  }

  var weatherGripMul = 1.0;
  function setWeatherGrip(mul) { weatherGripMul = safeNum(mul, 1); }

  // =========================================================================
  // 2. tuning — every number that shapes handling, grouped by subsystem
  // =========================================================================
  var tuning = {

    // World-unit <-> real-world conversion. Tracks/positions stay in "world
    // units" (unchanged elsewhere in the game); the simulation itself works
    // in real SI units (kg, metres, seconds, Newtons) and converts at the
    // boundary, so tuning below reads like a real car.
    scale: {
      groundCoverageMult: 1.25,
      baseKmhPerUnit: 0.54
    },
    // Used only to normalise speedFraction()/HUD-facing 0..1 values and the
    // camera-shake curve — the *actual* top speed emerges from the engine,
    // gearing, aero and drag below, so this is a reference, not a cap.
    reference: { topSpeedKmh: 360 },

  vehicle: {
      mass: 650,                  // Lightweight chassis for immediate directional changes
      cgHeight: 0.15,             // Low center of gravity eliminates suspension roll delays
      wheelbaseFront: 1.62,
      wheelbaseRear: 1.68,
      trackWidth: 1.70,
      yawInertia: 1000,            // Low rotational inertia so the car turns on a dime
      driveType: 'AWD'            // Ensures uniform traction under throttle
    },

    engine: {
      idleRpm: 1200,
      redlineRpm: 12000,
      frictionTorque: 40,
      // Curve matches the 15 m/s² launch down to 2 m/s² top-end acceleration
      torqueCurve: [
        { rpm: 1200, torque: 350 }, { rpm: 4000, torque: 580 },
        { rpm: 7000, torque: 620 }, { rpm: 9000, torque: 500 },
        { rpm: 11000, torque: 320 }, { rpm: 12000, torque: 200 }
      ]
    },

    drivetrain: {
      gearRatios: [3.8, 2.9, 2.3, 1.9, 1.6, 1.35, 1.15, 1.0],
      finalDrive: 3.6,
      efficiency: 0.98,
      shiftUpRpm: 11500,
      shiftDownRpm: 6000,
      shiftCooldown: 0.05,
      diffLock: 0.15,             // Low diff lock so inner/outer wheels turn freely in tight bends
      diffCouplingGain: 50,
      reverseTorque: 600,
      awdFrontFraction: 0.60      // 50/50 power split
    },

    tires: {
      radius: 0.33,
      inertia: 1.2,
      rollingResistance: 0.010,
      longB: 15, longC: 1.6, longE: -0.3,
      latB: 14, latC: 1.8, latE: 0.0,       // Ultra-high lateral stiffness (instant turn response)
      peakMu: 8.50,                // Recreates the ~9.2g grip ceiling from physics.js
      optimalTempC: 95,
      tempWindowC: 100,            // Disables temperature-based grip loss
      warmupPerKJ: 0.0,
      coolRatePerSec: 0.0,
      wearPerKJ: 0.0,
      wearGripLoss: 0.0
    },

    aero: {
      dragCoeff: 0.45,
      frontalArea: 1.5,
      liftCoeff: 3.5,
      frontAeroBalance: 0.32,       // Perfectly balanced downforce
      airDensity: 1.225
    },

    brakes: {
      maxTorque: 2600,              // Nm, combined front+rear reference
      frontBias: 0.60
    },

    suspension: {
      weightTransferSmoothing: 6.0,// Instantaneous weight transfer removes turn-in slop
      rollStiffnessFrontFrac: 0.75
    },

    steering: {
      maxAngleDeg: 32,              // Deep angle matching the old turnRate
      speedSensitivity: 0.005,      // Keeps full steering authority even at 360 km/h
      rateIn: 3.8,                  // Direct turn-in matching steerIn: 4.25
      rateOut: 6.5                // Fast self-centering matching steerOut: 7.0
    },

    assists: {
      abs: true,
      absSlipTarget: -0.12,
      tractionControl: true,
      tcSlipTarget: 0.05,          // Raised to 0.20 to utilize the higher traction limit
      stabilityControl: true,
      escGain: 1.2,                
      autoGear: true
    },

    environment: {
      gravity: 9.81,
      windX: 0, windZ: 0,           // world-frame wind, m/s — for future weather
      ambientTempC: 25
    },

    fuel: {
      capacityL: 110,
      density: 0.75,                // kg/L, used only for mass effect
      startFraction: 0.55,
      consumptionPerKJ: 0.000006    // litres consumed per kJ of drive energy
    },

    collision: {
      restitution: 0.35,
      tangentFriction: 0.55,
      yawKickGain: 0.05,
      minWallSpeedForEvent: 3       // m/s, below this a "wallHit" event doesn't fire
    },

    offTrack: {
      dragDecel: 12.0,            // Speed scrub (m/s²) when on grass/gravel (rapid slowdown)
      accelMul: 0.30,             // Throttle power cut to 30% off-track
      gripMult: 0.25              // Reduces tire grip to 25% off-track so you can't corner fast
    },

    // per-zone grip/rolling-resistance table; swap out via registerSurfaceSet
    surfaces: SURFACE_SETS.default,

    minWheelLoad: 40                // N, keeps a "lifted" wheel from a divide-by-zero
  };

  // =========================================================================
  // 3. derived cache — recomputed by refresh(), never edited directly
  // =========================================================================
  var d = {};
  function refresh() {
    var v = tuning.vehicle, sc = tuning.scale;

    d.kmhPerUnit = sc.baseKmhPerUnit / sc.groundCoverageMult;
    d.mpsPerUnit = d.kmhPerUnit / 3.6;
    d.maxSpeedRef = tuning.reference.topSpeedKmh / d.kmhPerUnit; // world units/sec, normalisation only

    d.wheelbase = v.wheelbaseFront + v.wheelbaseRear;
    d.yawInertia = v.yawInertia || (v.mass * (d.wheelbase * d.wheelbase + v.trackWidth * v.trackWidth) / 12) * 1.15;

    d.torqueCurve = tuning.engine.torqueCurve.slice().sort(function (a, b) { return a.rpm - b.rpm; });
    d.gearCount = tuning.drivetrain.gearRatios.length;

    d.fuelStartL = tuning.fuel.capacityL * tuning.fuel.startFraction;
  }
  refresh();

  // =========================================================================
  // 4. events + extension hooks — so future features can bolt on cleanly
  // =========================================================================
  var listeners = {};
  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
  function off(evt, fn) {
    var l = listeners[evt]; if (!l) return;
    var i = l.indexOf(fn); if (i !== -1) l.splice(i, 1);
  }
  function emit(evt, payload) {
    var l = listeners[evt]; if (!l) return;
    for (var i = 0; i < l.length; i++) { try { l[i](payload); } catch (e) {} }
  }
  var extensions = [];
  function registerExtension(fn) { extensions.push(fn); }

  // =========================================================================
  // 5. car state
  // =========================================================================
  // Wheel order used throughout: 0 = FL, 1 = FR, 2 = RL, 3 = RR.
  function createCar() {
    return {
      // ---- external contract: read by game.js / hud.js / multiplayer.js ----
      x: 0, y: 0, angle: 0,
      vf: 0, vl: 0,             // body-frame forward/lateral speed, world units/sec
      steer: 0,                  // smoothed steering input, -1..1
      wvx: 0, wvy: 0, av: 0,     // world-frame velocity + yaw rate (multiplayer sync)
      gripHealth: 1,              // aggregate available-grip fraction, 0..1

      // ---- engine / drivetrain ----
      rpm: tuning.engine.idleRpm,
      gear: 1,
      reversing: false,
      shiftCooldown: 0,

      // ---- per-wheel dynamic state ----
      wheelOmega: [0, 0, 0, 0],       // rad/s
      wheelLoad: [0, 0, 0, 0],        // N
      wheelSlipRatio: [0, 0, 0, 0],
      wheelSlipAngle: [0, 0, 0, 0],
      tireTemp: [25, 25, 25, 25],     // deg C
      tireWear: [0, 0, 0, 0],         // 0..1

      // ---- weight-transfer state (smoothed, suspension-like lag) ----
      lastAx: 0, lastAy: 0,           // m/s^2, previous substep's body accel

      // ---- consumables / condition ----
      fuel: d.fuelStartL,
      damage: 0,                       // 0..1, reserved for a future damage model

      // ---- diagnostics, safe to read from anywhere (HUD, telemetry, AI) ----
      telemetry: {}
    };
  }

  function placeAt(car, slot) {
    car.x = slot.x; car.y = slot.y; car.angle = slot.angle;
    car.vf = 0; car.vl = 0; car.steer = 0;
    car.wvx = 0; car.wvy = 0; car.av = 0;
    car.gripHealth = 1;

    car.rpm = tuning.engine.idleRpm;
    car.gear = 1;
    car.reversing = false;
    car.shiftCooldown = 0;

    car.wheelOmega = [0, 0, 0, 0];
    car.wheelLoad = [0, 0, 0, 0];
    car.wheelSlipRatio = [0, 0, 0, 0];
    car.wheelSlipAngle = [0, 0, 0, 0];
    car.tireTemp = [tuning.environment.ambientTempC, tuning.environment.ambientTempC,
                     tuning.environment.ambientTempC, tuning.environment.ambientTempC];
    car.tireWear = [0, 0, 0, 0];

    car.lastAx = 0; car.lastAy = 0;
    car.fuel = d.fuelStartL;
    car.damage = 0;
    car.telemetry = {};
  }

  // =========================================================================
  // 6. the core integrator — advances the car by one small, fixed sub-step
  // =========================================================================
  var MAX_SUBSTEP = 1 / 120;

  function tireGripMultiplier(tempC, wear) {
    var tw = tuning.tires;
    var tempLoss = clamp(Math.abs(tempC - tw.optimalTempC) / tw.tempWindowC, 0, 1) * 0.4;
    var wearLoss = wear * tw.wearGripLoss;
    return clamp(1 - tempLoss - wearLoss, 0.25, 1);
  }

  function substep(car, keys, track, dt) {
    var V = tuning.vehicle, E = tuning.engine, DT = tuning.drivetrain, TP = tuning.tires,
        A = tuning.aero, B = tuning.brakes, ST = tuning.steering, AS = tuning.assists,
        ENV = tuning.environment, SUS = tuning.suspension;

    // ---- where are we, and what are we driving on -------------------------
    var info0 = track.nearestTrackInfo(car.x, car.y);
    var surf = surfaceSetFor(track);
    var zone = surfaceZone(track, info0.point.d);
    var zoneDef = surf[zone] || surf.tarmac;
    var offTrack = info0.point.d > track.HALF_WIDTH - 4;

    var mass = V.mass + car.fuel * tuning.fuel.density;
    var a = V.wheelbaseFront, b = V.wheelbaseRear, tw = V.trackWidth;

    // ---- convert persistent state into real (SI) units for this step ------
    var vf = car.vf * d.mpsPerUnit;   // forward speed, m/s
    var vl = car.vl * d.mpsPerUnit;   // lateral (rightward) speed, m/s
    var av = car.av;                   // yaw rate, rad/s (unit-independent)

    var vxSafe = Math.abs(vf) < 0.6 ? (vf >= 0 ? 0.6 : -0.6) : vf;

    // ---- steering -----------------------------------------------------------
    var maxAngle = deg2rad(ST.maxAngleDeg) / (1 + Math.abs(vf) * ST.speedSensitivity);
    var steerTarget = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    var rate = (steerTarget === 0) ? ST.rateOut : ST.rateIn;
    car.steer += (steerTarget - car.steer) * clamp(rate * dt, 0, 1);
    if (Math.abs(car.steer) < 0.001) car.steer = 0;
    var delta = car.steer * maxAngle;

    // ---- slip angles, front and rear axle -----------------------------------
    var vlF = vl + av * a, vlR = vl - av * b;
    var absVx = Math.abs(vxSafe);
    var dir = sign(vxSafe) || 1;
    var alphaF = clamp(delta * dir - Math.atan2(vlF, absVx), -1.3, 1.3);
    var alphaR = clamp(-Math.atan2(vlR, absVx), -1.3, 1.3);

    // ---- weight transfer (uses last step's accel — a one-frame lag stands
    // in for suspension compliance so load doesn't snap instantly) ----------
    var g = ENV.gravity;
    var wfStatic = mass * g * b / (a + b), wrStatic = mass * g * a / (a + b);
    var longTransfer = mass * car.lastAx * V.cgHeight / (a + b);
    var speedSq = vf * vf + vl * vl;
    var downforce = 0.5 * A.airDensity * A.liftCoeff * A.frontalArea * speedSq;
    var wf = wfStatic - longTransfer + downforce * A.frontAeroBalance;
    var wr = wrStatic + longTransfer + downforce * (1 - A.frontAeroBalance);

    var latTransferTotal = mass * car.lastAy * V.cgHeight / tw;
    var latF = latTransferTotal * SUS.rollStiffnessFrontFrac;
    var latR = latTransferTotal * (1 - SUS.rollStiffnessFrontFrac);

    var minLoad = tuning.minWheelLoad;
    var loads = [
      Math.max(minLoad, wf / 2 + latF),   // FL
      Math.max(minLoad, wf / 2 - latF),   // FR
      Math.max(minLoad, wr / 2 + latR),   // RL
      Math.max(minLoad, wr / 2 - latR)    // RR
    ];
    car.wheelLoad = loads;

    // ---- per-wheel effective grip: surface * weather * temperature * wear -
    var muEff = [0, 0, 0, 0];
    for (var wi = 0; wi < 4; wi++) {
      muEff[wi] = TP.peakMu * zoneDef.muMul * weatherGripMul *
        tireGripMultiplier(car.tireTemp[wi], car.tireWear[wi]);
    }

    // ---- throttle / brake / reverse state machine --------------------------
    var throttle = keys.up ? 1 : 0;
    var brakeIn = keys.down ? 1 : 0;
    if (brakeIn && vf <= 1.0) car.reversing = true;
    if (throttle || vf > 2.0) car.reversing = false;

    // ---- engine + gearbox (forward driving only; reverse bypasses this) ---
    var drivenIdx = (V.driveType === 'FWD') ? [0, 1] : (V.driveType === 'AWD') ? [0, 1, 2, 3] : [2, 3];
    var drivenOmegaAvg = 0;
    for (var di = 0; di < drivenIdx.length; di++) drivenOmegaAvg += car.wheelOmega[drivenIdx[di]];
    drivenOmegaAvg /= drivenIdx.length;

    var driveTorque = [0, 0, 0, 0]; // per wheel, Nm
    car.shiftCooldown = Math.max(0, car.shiftCooldown - dt);

    if (!car.reversing) {
      var ratio = DT.gearRatios[clamp(car.gear, 1, d.gearCount) - 1];
      var engineOmega = Math.abs(drivenOmegaAvg) * ratio * DT.finalDrive;
      car.rpm = clamp(engineOmega * 60 / (2 * Math.PI), E.idleRpm, E.redlineRpm * 1.03);

      if (AS.autoGear && car.shiftCooldown <= 0) {
        if (car.rpm > DT.shiftUpRpm && car.gear < d.gearCount) {
          car.gear++; car.shiftCooldown = DT.shiftCooldown; emit('gearShift', { car: car, gear: car.gear });
        } else if (car.rpm < DT.shiftDownRpm && car.gear > 1 && vf > 1) {
          car.gear--; car.shiftCooldown = DT.shiftCooldown; emit('gearShift', { car: car, gear: car.gear });
        }
      }

      var engineTorque = interpCurve(d.torqueCurve, car.rpm) * throttle;
      if (throttle < 0.05) engineTorque -= E.frictionTorque; // engine braking

      var wheelTorqueTotal = engineTorque * ratio * DT.finalDrive * DT.efficiency;

      if (V.driveType === 'AWD') {
        var frontTotal = wheelTorqueTotal * DT.awdFrontFraction;
        var rearTotal = wheelTorqueTotal * (1 - DT.awdFrontFraction);
        applyDiff(driveTorque, [0, 1], frontTotal, car, DT);
        applyDiff(driveTorque, [2, 3], rearTotal, car, DT);
      } else {
        applyDiff(driveTorque, drivenIdx, wheelTorqueTotal, car, DT);
      }

      // traction control: trims torque on a driven wheel that is spinning
      // faster than the tyre can put down
      if (AS.tractionControl && throttle > 0) {
        for (var ti = 0; ti < drivenIdx.length; ti++) {
          var wIdx = drivenIdx[ti];
          var prevSlip = car.wheelSlipRatio[wIdx];
          if (prevSlip > AS.tcSlipTarget) {
            var tcMul = clamp(1 - (prevSlip - AS.tcSlipTarget) * 4, 0.15, 1);
            driveTorque[wIdx] *= tcMul;
            emit('wheelSpin', { car: car, wheel: wIdx });
          }
        }
      }
    } else {
      car.rpm = E.idleRpm;
      var revTorque = -DT.reverseTorque * brakeIn;
      for (var ri = 0; ri < drivenIdx.length; ri++) driveTorque[drivenIdx[ri]] = revTorque / drivenIdx.length;
    }

    // ---- brakes (front/rear bias), with ABS trimming lock-up --------------
    var brakeTorque = [0, 0, 0, 0];
    if (brakeIn && !car.reversing) {
      var frontEach = B.maxTorque * B.frontBias * brakeIn / 2;
      var rearEach = B.maxTorque * (1 - B.frontBias) * brakeIn / 2;
      brakeTorque = [frontEach, frontEach, rearEach, rearEach];
      if (AS.abs) {
        for (var bi = 0; bi < 4; bi++) {
          var prevK = car.wheelSlipRatio[bi];
          if (prevK < AS.absSlipTarget) {
            var absMul = clamp(1 - (AS.absSlipTarget - prevK) * 3, 0.1, 1);
            brakeTorque[bi] *= absMul;
            emit('wheelLock', { car: car, wheel: bi });
          }
        }
      }
    }

    // ---- per-wheel tyre forces + wheel spin-up/down -------------------------
    var offsets = [ // [longitudinal offset from CG, lateral offset], metres
      [a, -tw / 2], [a, tw / 2], [-b, -tw / 2], [-b, tw / 2]
    ];
    var bumpAmp = zoneDef.bumpiness;
    var FxBody = 0, FyBody = 0, Mtotal = 0;
    var totalSlipEnergy = 0, totalDriveWork = 0;

    for (var i = 0; i < 4; i++) {
      var isFront = i < 2;
      var kappaRef = vxSafe;
      var kappa = clamp((car.wheelOmega[i] * TP.radius - kappaRef) / Math.max(Math.abs(kappaRef), 0.8), -1.5, 1.5);
      var alpha = isFront ? alphaF : alphaR;

      var tf = combinedTireForce(kappa, alpha, loads[i], muEff[i], TP);
      var fxWheel = tf.Fx, fyWheel = tf.Fy;

      // a little random texture on curbs/grass so they feel different, not
      // just "less grippy"
      if (bumpAmp > 0) fyWheel += (Math.random() - 0.5) * bumpAmp * loads[i] * 0.08;

      // rolling resistance, applied directly as a small opposing force
      var rr = -sign(kappaRef) * TP.rollingResistance * zoneDef.rollMul * loads[i];
      fxWheel += rr;

      // rotate the front wheels' force into the body frame by the steer angle
      var fxBodyWheel, fyBodyWheel;
      if (isFront) {
        fxBodyWheel = fxWheel * Math.cos(delta) - fyWheel * Math.sin(delta);
        fyBodyWheel = fxWheel * Math.sin(delta) + fyWheel * Math.cos(delta);
      } else {
        fxBodyWheel = fxWheel; fyBodyWheel = fyWheel;
      }

      FxBody += fxBodyWheel; FyBody += fyBodyWheel;
      // 2D moment about the CG for a force at (x0, y0) in body (forward,right) axes
      Mtotal += offsets[i][0] * fyBodyWheel - offsets[i][1] * fxBodyWheel;

      // wheel rotational dynamics
      var reactionTorque = fxWheel * TP.radius;
      var domega = (driveTorque[i] - sign(car.wheelOmega[i]) * brakeTorque[i] - reactionTorque) / TP.inertia;
      car.wheelOmega[i] += domega * dt;

      // thermal + wear bookkeeping
      var slipPowerW = Math.abs(fxWheel * kappa * kappaRef) + Math.abs(fyWheel * alpha * kappaRef);
      var slipEnergyKJ = Math.abs(slipPowerW) * dt / 1000;
      totalSlipEnergy += slipEnergyKJ;
      totalDriveWork += Math.abs(driveTorque[i] * car.wheelOmega[i]) * dt / 1000;

      car.tireTemp[i] += (slipEnergyKJ * 1000 * TP.warmupPerKJ / 1000 - (car.tireTemp[i] - ENV.ambientTempC) * TP.coolRatePerSec) * dt;
      car.tireTemp[i] = clamp(car.tireTemp[i], -20, 180);
      car.tireWear[i] = clamp(car.tireWear[i] + slipEnergyKJ * TP.wearPerKJ, 0, 1);

      car.wheelSlipRatio[i] = kappa;
      car.wheelSlipAngle[i] = alpha;
    }

    // ---- aerodynamic drag (opposes motion relative to the wind) -----------
    var windForwardComp = ENV.windX * Math.cos(car.angle) + ENV.windZ * Math.sin(car.angle);
    var relVf = vf - windForwardComp;
    var drag = 0.5 * A.airDensity * A.dragCoeff * A.frontalArea * relVf * Math.abs(relVf);
    FxBody -= drag;

    // ---- stability control: a small corrective yaw moment when the car is
    // rotating faster than the tyres can be generating on their own -------
    if (AS.stabilityControl) {
      var yawDemand = Math.abs(delta) > 0.001 ? (vxSafe / Math.max(a + b, 0.1)) * Math.tan(delta) : 0;
      var yawError = av - yawDemand;
      Mtotal -= yawError * AS.escGain * d.yawInertia * 1.5;
    }

    // ---- integrate body-frame velocity + yaw (coupled rotating-frame terms) -
    var ax = FxBody / mass, ay = FyBody / mass;
    vf += (ax + av * vl) * dt;
    vl += (ay - av * vf) * dt;
    av += (Mtotal / d.yawInertia) * dt;

    // safety clamps so a stiff transient can't explode the integration
    vf = clamp(safeNum(vf, 0), -60, d.maxSpeedRef * d.mpsPerUnit * 1.3);
    vl = clamp(safeNum(vl, 0), -45, 45);
    av = clamp(safeNum(av, 0), -6, 6);

    car.lastAx = lerp(car.lastAx, ax, clamp(dt * SUS.weightTransferSmoothing, 0, 1));
    car.lastAy = lerp(car.lastAy, ay, clamp(dt * SUS.weightTransferSmoothing, 0, 1));

    car.angle += av * dt;
    car.av = av;
    car.vf = vf / d.mpsPerUnit;
    car.vl = vl / d.mpsPerUnit;

    // ---- position integration (world units, unchanged scale) --------------
    var fwX = Math.cos(car.angle), fwY = Math.sin(car.angle);
    var rgX = -Math.sin(car.angle), rgY = Math.cos(car.angle);
    var wvx = fwX * car.vf + rgX * car.vl;
    var wvy = fwY * car.vf + rgY * car.vl;
    var prevX = car.x, prevY = car.y;
    car.x += wvx * dt;
    car.y += wvy * dt;

    // ---- barrier collision (impulse-based, mass and restitution aware) ----
    var info = track.nearestTrackInfo(car.x, car.y);
    var limit = track.BARRIER_HW - track.CAR_RADIUS;
    if (info.point.d > limit) {
      var nx = (car.x - info.point.x) / (info.point.d || 1);
      var ny = (car.y - info.point.y) / (info.point.d || 1);
      car.x = info.point.x + nx * limit;
      car.y = info.point.y + ny * limit;

      var outward = wvx * nx + wvy * ny;
      if (outward > 0) {
        var impactSpeed = outward; // world units/sec, roughly m/s scale via mpsPerUnit
        var nvx = wvx - nx * outward * (1 + tuning.collision.restitution);
        var nvy = wvy - ny * outward * (1 + tuning.collision.restitution);
        // tangential scrub
        var tx = -ny, ty = nx;
        var tangential = nvx * tx + nvy * ty;
        nvx -= tx * tangential * tuning.collision.tangentFriction;
        nvy -= ty * tangential * tuning.collision.tangentFriction;

        car.vf = nvx * fwX + nvy * fwY;
        car.vl = nvx * rgX + nvy * rgY;
        car.av += -sign(tangential) * Math.abs(impactSpeed) * tuning.collision.yawKickGain;

        wvx = nvx; wvy = nvy;
        if (Math.abs(impactSpeed) * d.mpsPerUnit > tuning.collision.minWallSpeedForEvent) {
          emit('wallHit', { car: car, speed: Math.abs(impactSpeed) * d.mpsPerUnit });
        }
      }
    }

    car.wvx = wvx; car.wvy = wvy;

    // ---- fuel + aggregate grip health ---------------------------------------
    var fuelUsed = (totalDriveWork + totalSlipEnergy * 0.15) * tuning.fuel.consumptionPerKJ;
    car.fuel = Math.max(0, car.fuel - fuelUsed);
    if (car.fuel < d.fuelStartL * 0.1) emit('lowFuel', { car: car, fuel: car.fuel });

    var avgMu = (muEff[0] + muEff[1] + muEff[2] + muEff[3]) / 4;
    car.gripHealth = clamp(avgMu / TP.peakMu, 0, 1);

    car.telemetry = {
      rpm: car.rpm, gear: car.reversing ? -1 : car.gear,
      surface: zone, loads: loads.slice(), slipRatio: car.wheelSlipRatio.slice(),
      slipAngle: car.wheelSlipAngle.slice(), tireTemp: car.tireTemp.slice(),
      tireWear: car.tireWear.slice(), fuel: car.fuel
    };

    return { info: info, prevX: prevX, prevY: prevY, offTrack: offTrack };
  }

  // Limited-slip differential: splits torque evenly, then nudges it to pull
  // the two wheel speeds together by `diffLock` — 0 behaves like an open
  // diff (all torque can go to the spinning wheel), 1 behaves near-locked.
  function applyDiff(driveTorque, idxPair, total, car, DT) {
    var half = total / idxPair.length;
    if (idxPair.length === 2) {
      var wA = idxPair[0], wB = idxPair[1];
      var diff = (car.wheelOmega[wB] - car.wheelOmega[wA]) * DT.diffCouplingGain * DT.diffLock;
      driveTorque[wA] += half + diff;
      driveTorque[wB] += half - diff;
    } else {
      for (var i = 0; i < idxPair.length; i++) driveTorque[idxPair[i]] += half;
    }
  }

  // =========================================================================
  // 7. step() — the public entry point, sub-stepped for stability
  // =========================================================================
  function step(car, keys, track, dt) {
    dt = clamp(safeNum(dt, 0), 0, 0.1);
    var n = Math.max(1, Math.ceil(dt / MAX_SUBSTEP));
    var sub = dt / n;
    var prevX = car.x, prevY = car.y;
    var lastResult = null;
    var anyOffTrack = false;


    for (var s = 0; s < n; s++) {
      lastResult = substep(car, keys, track, sub);
      if (lastResult.offTrack) anyOffTrack = true;
    }

    for (var e = 0; e < extensions.length; e++) {
      try { extensions[e](car, track, dt); } catch (ex) {}
    }

    return {
      info: lastResult.info,
      prevX: prevX,
      prevY: prevY,
      offTrack: anyOffTrack
    };
  }

  // =========================================================================
  // 8. readouts used by HUD/camera
  // =========================================================================
  function speedKmh(car) { return Math.hypot(car.vf, car.vl) * d.kmhPerUnit; }
  function speedFraction(car) { return clamp(Math.abs(car.vf) / d.maxSpeedRef, 0, 1); }

  // =========================================================================
  // 9. car-vs-car collision — not wired into the game loop yet (there is
  // only ever one physically-simulated car per client today), but ready for
  // local AI opponents or same-machine split screen without redesigning
  // anything: an equal-mass elastic-ish impulse exchange along the contact
  // normal, in world units.
  // =========================================================================
  function resolveCarCollision(carA, carB, restitution) {
    restitution = safeNum(restitution, tuning.collision.restitution);
    var dx = carB.x - carA.x, dy = carB.y - carA.y;
    var dist = Math.hypot(dx, dy) || 1;
    var nx = dx / dist, ny = dy / dist;
    var rvx = carB.wvx - carA.wvx, rvy = carB.wvy - carA.wvy;
    var rel = rvx * nx + rvy * ny;
    if (rel >= 0) return; // separating already
    var j = -(1 + restitution) * rel / 2; // equal mass assumption
    carA.wvx -= j * nx; carA.wvy -= j * ny;
    carB.wvx += j * nx; carB.wvy += j * ny;
    emit('wallHit', { car: carA, speed: Math.abs(rel) * d.mpsPerUnit });
    emit('wallHit', { car: carB, speed: Math.abs(rel) * d.mpsPerUnit });
  }

  return {
    tuning: tuning,
    derived: d,
    refresh: refresh,
    clamp: clamp,

    createCar: createCar,
    placeAt: placeAt,
    step: step,
    speedKmh: speedKmh,
    speedFraction: speedFraction,

    registerExtension: registerExtension,
    on: on,
    off: off,
    registerSurfaceSet: registerSurfaceSet,
    setWeatherGrip: setWeatherGrip,
    resolveCarCollision: resolveCarCollision
  };
})();
