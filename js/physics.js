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
  // 0. MATHEMATICAL HELPERS & TIRE FORCE FORMULAS
  // =========================================================================

  /** Clamps a value between an inclusive lower and upper bound. */
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /** Returns the sign of a number (+1, -1, or 0). */
  function sign(v) { return v > 0 ? 1 : (v < 0 ? -1 : 0); }

  /** Linear interpolation between `a` and `b` by factor `t`. */
  function lerp(a, b, t) { return a + (b - a) * t; }

  /** Converts degrees to radians. */
  function deg2rad(d) { return d * Math.PI / 180; }

  /** Fallback utility to prevent NaN/Infinity poisoning in physics calculations. */
  function safeNum(v, fallback) { return (typeof v === 'number' && isFinite(v)) ? v : fallback; }

  /**
   * Evaluates the Pacejka Magic Formula (simplified evaluation curve).
   * Calculates normalized force multiplier based on slip input.
   *
   * @param {number} slip - Slip ratio (longitudinal) or Slip angle in radians (lateral).
   * @param {number} B - Stiffness factor.
   * @param {number} C - Shape factor.
   * @param {number} D - Peak value (maximum friction capacity).
   * @param {number} E - Curvature factor.
   * @returns {number} Force in Newtons.
   */
  function pacejka(slip, B, C, D, E) {
    var Bx = B * slip;
    return D * Math.sin(C * Math.atan(Bx - E * (Bx - Math.atan(Bx))));
  }

  /**
   * Combines longitudinal and lateral tire forces using friction ellipse scaling.
   * Prevents total vector force from exceeding available friction capacity (mu * Fz).
   *
   * @param {number} kappa - Longitudinal slip ratio.
   * @param {number} alpha - Lateral slip angle (radians).
   * @param {number} Fz - Normal vertical load on tire (N).
   * @param {number} muEff - Effective friction coefficient.
   * @param {Object} tp - Tire parameter tuning block.
   * @returns {{Fx: number, Fy: number}} Longitudinal and lateral force vector components.
   */
  function combinedTireForce(kappa, alpha, Fz, muEff, tp) {
    var cap = Math.max(muEff * Fz, 1e-4);
    var Fx0 = pacejka(kappa, tp.longB, tp.longC, cap, tp.longE);
    var Fy0 = pacejka(alpha, tp.latB, tp.latC, cap, tp.latE);
    
    // Friction circle normalization
    var fxN = Fx0 / cap, fyN = Fy0 / cap;
    var mag = Math.hypot(fxN, fyN);
    if (mag > 1) { fxN /= mag; fyN /= mag; }
    return { Fx: fxN * cap, Fy: fyN * cap };
  }

  /** Interpolates torque output based on current engine RPM using piecewise torque curve points. */
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
  // 1. SURFACE ZONES & ENVIRONMENT GRIP MODIFIERS
  // =========================================================================

  /** Surface parameter registry defining grip, rolling resistance, and roughness per terrain type. */
  var SURFACE_SETS = {
    default: {
      tarmac: { muMul: 1.00, rollMul: 1.0, bumpiness: 0.00 },
      curb:   { muMul: 0.88, rollMul: 1.2, bumpiness: 0.35 },
      runoff: { muMul: 0.70, rollMul: 1.5, bumpiness: 0.15 },
      gravel: { muMul: 0.55, rollMul: 2.0, bumpiness: 0.25 }
    }
  };

  /** Registers custom surface sets for specific track profiles. */
  function registerSurfaceSet(name, defs) { SURFACE_SETS[name] = defs; }

  /** Resolves the surface dictionary applicable to the active track instance. */
  function surfaceSetFor(track) {
    var name = track && track.def && track.def.surfaceSet;
    return (name && SURFACE_SETS[name]) || SURFACE_SETS.default;
  }

  /** Determines current surface zone based on vehicle distance `d` from track centerline. */
  function surfaceZone(track, d) {
    if (d <= track.HALF_WIDTH) return 'tarmac';
    if (d <= track.CURB_HW) return 'curb';
    if (d <= track.RUNOFF_HW) return 'runoff';
    return 'gravel';
  }

  /** Global weather multiplier scaling total track grip. */
  var weatherGripMul = 1.0;
  function setWeatherGrip(mul) { weatherGripMul = safeNum(mul, 1); }

  // =========================================================================
  // 2. TUNING CONFIGURATION
  // =========================================================================

  var tuning = {
    // World space to display scaling conversion
    scale: {
      groundCoverageMult: 1.25,
      baseKmhPerUnit: 0.54
    },
    reference: { topSpeedKmh: 360 },

    // Vehicle dimensions & mass properties
    vehicle: {
      mass: 650,               // Total dry mass (kg)
      cgHeight: 0.15,          // Center of gravity height (m)
      wheelbaseFront: 1.62,    // Distance CG to front axle (m)
      wheelbaseRear: 1.68,     // Distance CG to rear axle (m)
      trackWidth: 1.70,        // Axle width (m)
      yawInertia: 1000,        // Yaw moment of inertia (kg*m^2)
      driveType: 'AWD'         // Drivetrain: 'FWD', 'RWD', or 'AWD'
    },

    // Engine power curve parameters
    engine: {
      idleRpm: 1200,
      redlineRpm: 12000,
      frictionTorque: 40,      // Engine braking resistance (Nm)
      torqueCurve: [
        { rpm: 1200, torque: 350 }, { rpm: 4000, torque: 580 },
        { rpm: 7000, torque: 620 }, { rpm: 9000, torque: 500 },
        { rpm: 11000, torque: 320 }, { rpm: 12000, torque: 200 }
      ]
    },

    // Gearbox & differentials
    drivetrain: {
      gearRatios: [3.8, 2.9, 2.3, 1.9, 1.6, 1.35, 1.15, 1.0],
      finalDrive: 3.6,
      efficiency: 0.98,
      shiftUpRpm: 11500,
      shiftDownRpm: 6000,
      shiftCooldown: 0.05,     // Lockout time between shifts (seconds)
      diffLock: 0.35,          // Differential locking ratio
      diffCouplingGain: 50,
      reverseTorque: 600,
      awdFrontFraction: 0.60  // AWD front/rear torque split ratio
    },

    // Tire model & degradation rates
    tires: {
      radius: 0.33,            // Wheel radius (m)
      inertia: 1.2,           // Rotational inertia of wheel (kg*m^2)
      rollingResistance: 0.010,
      longB: 15, longC: 1.6, longE: -0.3, // Pacejka longitudinal parameters
      latB: 14, latC: 1.8, latE: 0.0,    // Pacejka lateral parameters
      peakMu: 8.50,           // Peak coefficient of friction
      optimalTempC: 95,
      tempWindowC: 100,
      warmupPerKJ: 0.0,
      coolRatePerSec: 0.0,
      wearPerKJ: 0.0,
      wearGripLoss: 0.0
    },

    // Aerodynamics
    aero: {
      dragCoeff: 0.45,
      frontalArea: 1.5,
      liftCoeff: 3.5,          // Downforce coefficient
      frontAeroBalance: 0.32,  // Front downforce percentage
      airDensity: 1.225
    },

    // Brakes
    brakes: {
      maxTorque: 2600,         // Total brake torque capacity (Nm)
      frontBias: 0.60          // Front-to-rear brake distribution
    },

    // Suspension load transfer dynamics
    suspension: {
      weightTransferSmoothing: 6.0,
      rollStiffnessFrontFrac: 0.75
    },

    // Steering speed sensitivity & response
    steering: {
      maxAngleDeg: 30,
      speedSensitivity: 0.005,
      rateIn: 3.8,
      rateOut: 6.5
    },

    // Electronic Driving Assists
    assists: {
      abs: true,
      absSlipTarget: -0.12,
      tractionControl: true,
      tcSlipTarget: 0.10,
      stabilityControl: true,
      escGain: 1.20,
      autoGear: true
    },

    environment: {
      gravity: 9.81,
      windX: 0, windZ: 0,
      ambientTempC: 25
    },

    fuel: {
      capacityL: 110,
      density: 0.75,
      startFraction: 0.55,
      consumptionPerKJ: 0.000006
    },

    collision: {
      restitution: 0.35,
      tangentFriction: 0.55,
      yawKickGain: 0.05,
      minWallSpeedForEvent: 3
    },

    // OFF-TRACK / GRASS MECHANICS (integrated from physics_2.js)
    offTrack: {
      accelMul: 0.55,        // Throttle effectiveness on grass/runoff
      drag: 0.10,            // Speed drag decay rate per second off tarmac
      gripLoss: 0.10,        // Rate of tire dirtying/grip loss per frame off track
      gripRecover: 0.001,    // Rate of tire cleaning/grip recovery per frame on tarmac
      gripFloor: 0.20        // Minimum friction multiplier floor for dirty tires
    },

    surfaces: SURFACE_SETS.default,
    minWheelLoad: 40
  };

  // =========================================================================
  // 3. DERIVED CACHE & RECALCULATION
  // =========================================================================

  var d = {};

  /** Recomputes derived cache parameters when core tuning variables change. */
  function refresh() {
    var v = tuning.vehicle, sc = tuning.scale;
    d.kmhPerUnit = sc.baseKmhPerUnit / sc.groundCoverageMult;
    d.mpsPerUnit = d.kmhPerUnit / 3.6;
    d.maxSpeedRef = tuning.reference.topSpeedKmh / d.kmhPerUnit;
    d.wheelbase = v.wheelbaseFront + v.wheelbaseRear;
    d.yawInertia = v.yawInertia || (v.mass * (d.wheelbase * d.wheelbase + v.trackWidth * v.trackWidth) / 12) * 1.15;
    d.torqueCurve = tuning.engine.torqueCurve.slice().sort(function (a, b) { return a.rpm - b.rpm; });
    d.gearCount = tuning.drivetrain.gearRatios.length;
    d.fuelStartL = tuning.fuel.capacityL * tuning.fuel.startFraction;
  }
  refresh();

  // =========================================================================
  // 4. EVENT SYSTEM & EXTENSIONS
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
  // 5. CAR STATE MANAGEMENT
  // =========================================================================

  /**
   * Instantiates a new vehicle dynamic state object.
   * Wheel Indices: [0: Front-Left, 1: Front-Right, 2: Rear-Left, 3: Rear-Right]
   */
  function createCar() {
    return {
      x: 0, y: 0, angle: 0,       // Position & orientation in world space
      vf: 0, vl: 0,               // Forward and lateral velocities (world units/s)
      steer: 0,                   // Steering input state (-1 to +1)
      wvx: 0, wvy: 0, av: 0,      // World velocity vectors & angular velocity
      gripHealth: 1,              // Off-track tire health factor (0.2 to 1.0)

      rpm: tuning.engine.idleRpm,
      gear: 1,
      reversing: false,
      shiftCooldown: 0,

      wheelOmega: [0, 0, 0, 0],     // Rotational velocity per wheel (rad/s)
      wheelLoad: [0, 0, 0, 0],      // Vertical load force per wheel (N)
      wheelSlipRatio: [0, 0, 0, 0], // Longitudinal slip ratio
      wheelSlipAngle: [0, 0, 0, 0], // Lateral slip angle (rad)
      tireTemp: [25, 25, 25, 25],   // Tire core temperature (C)
      tireWear: [0, 0, 0, 0],       // Tire wear percentage (0 to 1)

      lastAx: 0, lastAy: 0,        // Smoothed accelerations for weight transfer
      fuel: d.fuelStartL,
      damage: 0,
      telemetry: {}
    };
  }

  /** Resets vehicle state and places it at a designated starting slot. */
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
  // 6. CORE INTEGRATION & SUBSTEPPING
  // =========================================================================

  var MAX_SUBSTEP = 1 / 120; // Force step resolution ceiling for stability

  /** Calculates effective grip multiplier based on tire temperature and cumulative wear. */
  function tireGripMultiplier(tempC, wear) {
    var tw = tuning.tires;
    var tempLoss = clamp(Math.abs(tempC - tw.optimalTempC) / tw.tempWindowC, 0, 1) * 0.4;
    var wearLoss = wear * tw.wearGripLoss;
    return clamp(1 - tempLoss - wearLoss, 0.25, 1);
  }

  /**
   * Single discrete substep of the physics engine.
   * Handles weight transfer, off-track grip degradation, Pacejka tire forces, 
   * powertrain/drivetrain dynamics, aerodynamic downforce, and barrier impacts.
   */
  function substep(car, keys, track, dt) {
    var V = tuning.vehicle, E = tuning.engine, DT = tuning.drivetrain, TP = tuning.tires,
        A = tuning.aero, B = tuning.brakes, ST = tuning.steering, AS = tuning.assists,
        ENV = tuning.environment, SUS = tuning.suspension, OT = tuning.offTrack;

    // -----------------------------------------------------------------------
    // STEP A: Surface & Off-Track Detection
    // -----------------------------------------------------------------------
    var info0 = track.nearestTrackInfo(car.x, car.y);
    var surf = surfaceSetFor(track);
    var zone = surfaceZone(track, info0.point.d);
    var zoneDef = surf[zone] || surf.tarmac;
    var offTrack = info0.point.d > (track.HALF_WIDTH - 4);

    var mass = V.mass + car.fuel * tuning.fuel.density;
    var a = V.wheelbaseFront, b = V.wheelbaseRear, tw = V.trackWidth;

    var vf = car.vf * d.mpsPerUnit;
    var vl = car.vl * d.mpsPerUnit;
    var av = car.av;

    // Off-track speed drag & progressive tire dirtying logic
    var frameScale = dt * 60; 
    if (offTrack) {
      vf -= vf * OT.drag * dt; // Velocity-dependent drag scrub
      car.gripHealth = Math.max(OT.gripFloor, car.gripHealth - OT.gripLoss * frameScale);
    } else {
      car.gripHealth = Math.min(1.0, car.gripHealth + OT.gripRecover * frameScale);
    }

    var vxSafe = Math.abs(vf) < 0.6 ? (vf >= 0 ? 0.6 : -0.6) : vf;

    // -----------------------------------------------------------------------
    // STEP B: Steering Lock & Slip Angles
    // -----------------------------------------------------------------------
    var maxAngle = deg2rad(ST.maxAngleDeg) / (1 + Math.abs(vf) * ST.speedSensitivity);
    var steerTarget = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    var rate = (steerTarget === 0) ? ST.rateOut : ST.rateIn;
    car.steer += (steerTarget - car.steer) * clamp(rate * dt, 0, 1);
    if (Math.abs(car.steer) < 0.001) car.steer = 0;
    var delta = car.steer * maxAngle;

    // Kinematic slip angles per axle
    var vlF = vl + av * a, vlR = vl - av * b;
    var absVx = Math.abs(vxSafe);
    var dir = sign(vxSafe) || 1;
    var alphaF = clamp(delta * dir - Math.atan2(vlF, absVx), -1.3, 1.3);
    var alphaR = clamp(-Math.atan2(vlR, absVx), -1.3, 1.3);

    // -----------------------------------------------------------------------
    // STEP C: Dynamic Load & Aero Downforce Distribution
    // -----------------------------------------------------------------------
    var g = ENV.gravity;
    var wfStatic = mass * g * b / (a + b), wrStatic = mass * g * a / (a + b);
    
    // Longitudinal load transfer under acceleration/braking
    var longTransfer = mass * car.lastAx * V.cgHeight / (a + b);
    var speedSq = vf * vf + vl * vl;
    var downforce = 0.5 * A.airDensity * A.liftCoeff * A.frontalArea * speedSq;
    
    var wf = wfStatic - longTransfer + downforce * A.frontAeroBalance;
    var wr = wrStatic + longTransfer + downforce * (1 - A.frontAeroBalance);

    // Lateral load transfer under cornering
    var latTransferTotal = mass * car.lastAy * V.cgHeight / tw;
    var latF = latTransferTotal * SUS.rollStiffnessFrontFrac;
    var latR = latTransferTotal * (1 - SUS.rollStiffnessFrontFrac);

    var minLoad = tuning.minWheelLoad;
    var loads = [
      Math.max(minLoad, wf / 2 + latF), // Front-Left
      Math.max(minLoad, wf / 2 - latF), // Front-Right
      Math.max(minLoad, wr / 2 + latR), // Rear-Left
      Math.max(minLoad, wr / 2 - latR)  // Rear-Right
    ];
    car.wheelLoad = loads;

    // -----------------------------------------------------------------------
    // STEP D: Effective Tire Grip Calculation
    // -----------------------------------------------------------------------
    var muEff = [0, 0, 0, 0];
    for (var wi = 0; wi < 4; wi++) {
      // Combines surface type, weather, tire temp, wear, and off-track gripHealth
      muEff[wi] = TP.peakMu * zoneDef.muMul * weatherGripMul * car.gripHealth *
        tireGripMultiplier(car.tireTemp[wi], car.tireWear[wi]);
    }

    // -----------------------------------------------------------------------
    // STEP E: Throttle, Gearbox & Assist Control
    // -----------------------------------------------------------------------
    var accelMul = offTrack ? OT.accelMul : 1.0;
    var throttle = (keys.up ? 1 : 0) * accelMul;
    var brakeIn = keys.down ? 1 : 0;

    if (brakeIn && vf <= 1.0) car.reversing = true;
    if (throttle > 0 || vf > 2.0) car.reversing = false;

    var drivenIdx = (V.driveType === 'FWD') ? [0, 1] : (V.driveType === 'AWD') ? [0, 1, 2, 3] : [2, 3];
    var drivenOmegaAvg = 0;
    for (var di = 0; di < drivenIdx.length; di++) drivenOmegaAvg += car.wheelOmega[drivenIdx[di]];
    drivenOmegaAvg /= drivenIdx.length;

    var driveTorque = [0, 0, 0, 0];
    car.shiftCooldown = Math.max(0, car.shiftCooldown - dt);

    if (!car.reversing) {
      var ratio = DT.gearRatios[clamp(car.gear, 1, d.gearCount) - 1];
      var engineOmega = Math.abs(drivenOmegaAvg) * ratio * DT.finalDrive;
      car.rpm = clamp(engineOmega * 60 / (2 * Math.PI), E.idleRpm, E.redlineRpm * 1.03);

      // Automatic Transmission Logic
      if (AS.autoGear && car.shiftCooldown <= 0) {
        if (car.rpm > DT.shiftUpRpm && car.gear < d.gearCount) {
          car.gear++; car.shiftCooldown = DT.shiftCooldown; emit('gearShift', { car: car, gear: car.gear });
        } else if (car.rpm < DT.shiftDownRpm && car.gear > 1 && vf > 1) {
          car.gear--; car.shiftCooldown = DT.shiftCooldown; emit('gearShift', { car: car, gear: car.gear });
        }
      }

      var engineTorque = interpCurve(d.torqueCurve, car.rpm) * throttle;
      if (throttle < 0.05) engineTorque -= E.frictionTorque;

      var wheelTorqueTotal = engineTorque * ratio * DT.finalDrive * DT.efficiency;

      // Torque Distribution across Differentials
      if (V.driveType === 'AWD') {
        var frontTotal = wheelTorqueTotal * DT.awdFrontFraction;
        var rearTotal = wheelTorqueTotal * (1 - DT.awdFrontFraction);
        applyDiff(driveTorque, [0, 1], frontTotal, car, DT);
        applyDiff(driveTorque, [2, 3], rearTotal, car, DT);
      } else {
        applyDiff(driveTorque, drivenIdx, wheelTorqueTotal, car, DT);
      }

      // Traction Control System (TCS)
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

    // Anti-lock Braking System (ABS)
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

    // -----------------------------------------------------------------------
    // STEP F: Wheel Mechanics & Pacejka Evaluation
    // -----------------------------------------------------------------------
    var offsets = [
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

      // Surface roughness perturbation
      if (bumpAmp > 0) fyWheel += (Math.random() - 0.5) * bumpAmp * loads[i] * 0.08;

      var rr = -sign(kappaRef) * TP.rollingResistance * zoneDef.rollMul * loads[i];
      fxWheel += rr;

      // Transform front wheels lateral/longitudinal forces into body coordinates
      var fxBodyWheel, fyBodyWheel;
      if (isFront) {
        fxBodyWheel = fxWheel * Math.cos(delta) - fyWheel * Math.sin(delta);
        fyBodyWheel = fxWheel * Math.sin(delta) + fyWheel * Math.cos(delta);
      } else {
        fxBodyWheel = fxWheel; fyBodyWheel = fyWheel;
      }

      FxBody += fxBodyWheel; FyBody += fyBodyWheel;
      Mtotal += offsets[i][0] * fyBodyWheel - offsets[i][1] * fxBodyWheel;

      // Wheel rotational acceleration calculation
      var reactionTorque = fxWheel * TP.radius;
      var domega = (driveTorque[i] - sign(car.wheelOmega[i]) * brakeTorque[i] - reactionTorque) / TP.inertia;
      car.wheelOmega[i] += domega * dt;

      // Energy calculation for tire thermal dynamics & wear
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

    // Aerodynamic Drag
    var windForwardComp = ENV.windX * Math.cos(car.angle) + ENV.windZ * Math.sin(car.angle);
    var relVf = vf - windForwardComp;
    var drag = 0.5 * A.airDensity * A.dragCoeff * A.frontalArea * relVf * Math.abs(relVf);
    FxBody -= drag;

    // Electronic Stability Control (ESC)
    if (AS.stabilityControl) {
      var yawDemand = Math.abs(delta) > 0.001 ? (vxSafe / Math.max(a + b, 0.1)) * Math.tan(delta) : 0;
      var yawError = av - yawDemand;
      Mtotal -= yawError * AS.escGain * d.yawInertia * 1.5;
    }

    // -----------------------------------------------------------------------
    // STEP G: Rigid Body Equations of Motion Integration
    // -----------------------------------------------------------------------
    var ax = FxBody / mass, ay = FyBody / mass;
    vf += (ax + av * vl) * dt;
    vl += (ay - av * vf) * dt;
    av += (Mtotal / d.yawInertia) * dt;

    vf = clamp(safeNum(vf, 0), -60, d.maxSpeedRef * d.mpsPerUnit * 1.3);
    vl = clamp(safeNum(vl, 0), -45, 45);
    av = clamp(safeNum(av, 0), -6, 6);

    car.lastAx = lerp(car.lastAx, ax, clamp(dt * SUS.weightTransferSmoothing, 0, 1));
    car.lastAy = lerp(car.lastAy, ay, clamp(dt * SUS.weightTransferSmoothing, 0, 1));

    car.angle += av * dt;
    car.av = av;
    car.vf = vf / d.mpsPerUnit;
    car.vl = vl / d.mpsPerUnit;

    // Position updates in world coordinate frame
    var fwX = Math.cos(car.angle), fwY = Math.sin(car.angle);
    var rgX = -Math.sin(car.angle), rgY = Math.cos(car.angle);
    var wvx = fwX * car.vf + rgX * car.vl;
    var wvy = fwY * car.vf + rgY * car.vl;
    var prevX = car.x, prevY = car.y;
    car.x += wvx * dt;
    car.y += wvy * dt;

    // -----------------------------------------------------------------------
    // STEP H: Track Barrier Impulse & Collision Resolution
    // -----------------------------------------------------------------------
    var info = track.nearestTrackInfo(car.x, car.y);
    var limit = track.BARRIER_HW - track.CAR_RADIUS;
    if (info.point.d > limit) {
      var nx = (car.x - info.point.x) / (info.point.d || 1);
      var ny = (car.y - info.point.y) / (info.point.d || 1);
      car.x = info.point.x + nx * limit;
      car.y = info.point.y + ny * limit;

      var outward = wvx * nx + wvy * ny;
      if (outward > 0) {
        var impactSpeed = outward;
        var nvx = wvx - nx * outward * (1 + tuning.collision.restitution);
        var nvy = wvy - ny * outward * (1 + tuning.collision.restitution);
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

    // -----------------------------------------------------------------------
    // STEP I: Telemetry & Fuel Consumption
    // -----------------------------------------------------------------------
    var fuelUsed = (totalDriveWork + totalSlipEnergy * 0.15) * tuning.fuel.consumptionPerKJ;
    car.fuel = Math.max(0, car.fuel - fuelUsed);
    if (car.fuel < d.fuelStartL * 0.1) emit('lowFuel', { car: car, fuel: car.fuel });

    car.telemetry = {
      rpm: car.rpm, gear: car.reversing ? -1 : car.gear,
      surface: zone, loads: loads.slice(), slipRatio: car.wheelSlipRatio.slice(),
      slipAngle: car.wheelSlipAngle.slice(), tireTemp: car.tireTemp.slice(),
      tireWear: car.tireWear.slice(), fuel: car.fuel, gripHealth: car.gripHealth
    };

    return { info: info, prevX: prevX, prevY: prevY, offTrack: offTrack };
  }

  /** Distributes engine drive torque across axle differential. */
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
  // 7. PUBLIC INTEGRATOR STEP ENTRYPOINT
  // =========================================================================

  /**
   * Main step entrypoint for updating vehicle physics state.
   * Divides incoming frame standard delta time (`dt`) into smaller fixed sub-steps
   * to guarantee numerical stability at high speeds.
   *
   * @param {Object} car - The vehicle state instance.
   * @param {Object} keys - Key input state object ({ up, down, left, right }).
   * @param {Object} track - Track geometry instance.
   * @param {number} dt - Frame time elapsed in seconds.
   * @returns {{ info: Object, prevX: number, prevY: number, offTrack: boolean }} Step metadata.
   */
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

    // Execute active extension hooks
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
  // 8. READOUT HELPERS & CAR-TO-CAR COLLISIONS
  // =========================================================================

  /** Returns absolute velocity in km/h. */
  function speedKmh(car) { return Math.hypot(car.vf, car.vl) * d.kmhPerUnit; }

  /** Returns normalized ratio of top speed (0.0 to 1.0). */
  function speedFraction(car) { return clamp(Math.abs(car.vf) / d.maxSpeedRef, 0, 1); }

  /**
   * Performs impulse resolution for car-to-car elastic collisions in multiplayer / AI mode.
   *
   * @param {Object} carA - First vehicle state.
   * @param {Object} carB - Second vehicle state.
   * @param {number} [restitution] - Coefficient of restitution override.
   */
  function resolveCarCollision(carA, carB, restitution) {
    restitution = safeNum(restitution, tuning.collision.restitution);
    var dx = carB.x - carA.x, dy = carB.y - carA.y;
    var dist = Math.hypot(dx, dy) || 1;
    var nx = dx / dist, ny = dy / dist;
    var rvx = carB.wvx - carA.wvx, rvy = carB.wvy - carA.wvy;
    var rel = rvx * nx + rvy * ny;
    if (rel >= 0) return;
    var j = -(1 + restitution) * rel / 2;
    carA.wvx -= j * nx; carA.wvy -= j * ny;
    carB.wvx += j * nx; carB.wvy += j * ny;
    emit('wallHit', { car: carA, speed: Math.abs(rel) * d.mpsPerUnit });
    emit('wallHit', { car: carB, speed: Math.abs(rel) * d.mpsPerUnit });
  }

  // =========================================================================
  // EXPORT PUBLIC MODULE API
  // =========================================================================
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
