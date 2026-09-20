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
 
  /**
   * Clamps a numerical value within a specified bounding range [lo, hi].
   * @param {number} v - Input value.
   * @param {number} lo - Minimum bound.
   * @param {number} hi - Maximum bound.
   * @returns {number} Clamped scalar value.
   */
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
 
  /**
   * Evaluates the sign of a numerical value (-1, 0, or 1).
   * @param {number} v - Input value.
   * @returns {number} Sign indicator.
   */
  function sign(v) { return v > 0 ? 1 : (v < 0 ? -1 : 0); }
 
  /**
   * Linearly interpolates between start and end scalars by factor `t`.
   * @param {number} a - Start value.
   * @param {number} b - Target value.
   * @param {number} t - Interpolation coefficient [0..1].
   * @returns {number} Interpolated result.
   */
  function lerp(a, b, t) { return a + (b - a) * t; }
 
  /**
   * Converts angular measurement from degrees to radians.
   * @param {number} d - Angle in degrees.
   * @returns {number} Angle in radians.
   */
  function deg2rad(d) { return d * Math.PI / 180; }
 
  /**
   * Guarantees a value is a valid finite number, substituting a fallback otherwise.
   * @param {*} v - Target object/value to check.
   * @param {number} fallback - Default numeric value if non-finite or invalid.
   * @returns {number} Guaranteed finite number.
   */
  function safeNum(v, fallback) { return (typeof v === 'number' && isFinite(v)) ? v : fallback; }
 
  /**
   * Calculates slip friction factor via simplified Pacejka Magic Formula curve.
   * @param {number} slip - Input slip ratio (longitudinal) or slip angle (lateral).
   * @param {number} B - Stiffness factor.
   * @param {number} C - Shape factor.
   * @param {number} D - Peak value (grip capacity limit).
   * @param {number} E - Curvature factor.
   * @returns {number} Calculated tire force component.
   */
  function pacejka(slip, B, C, D, E) {
    var Bx = B * slip;
    return D * Math.sin(C * Math.atan(Bx - E * (Bx - Math.atan(Bx))));
  }
 
  /**
   * Resolves combined-slip longitudinal (Fx) and lateral (Fy) tire forces bounded
   * within a circular friction envelope (friction circle).
   * @param {number} kappa - Wheel slip ratio (longitudinal).
   * @param {number} alpha - Wheel slip angle in radians (lateral).
   * @param {number} Fz - Normal vertical tire load (N).
   * @param {number} muEff - Effective friction coefficient under current conditions.
   * @param {Object} tp - Tire parameters object containing Pacejka coefficients.
   * @returns {{Fx: number, Fy: number}} Resolved longitudinal and lateral forces.
   */
  function combinedTireForce(kappa, alpha, Fz, muEff, tp) {
    var cap = Math.max(muEff * Fz, 1e-4);
    var Fx0 = pacejka(kappa, tp.longB, tp.longC, cap, tp.longE);
    var Fy0 = pacejka(alpha, tp.latB, tp.latC, cap, tp.latE);
    
    var fxN = Fx0 / cap, fyN = Fy0 / cap;
    var mag = Math.hypot(fxN, fyN);
    if (mag > 1) { fxN /= mag; fyN /= mag; }
    return { Fx: fxN * cap, Fy: fyN * cap };
  }
 
  /**
   * Interpolates torque from engine RPM piecewise linear lookup curves.
   * @param {Array<{rpm: number, torque: number}>} curve - Ordered array of RPM/Torque mappings.
   * @param {number} x - Current engine RPM.
   * @returns {number} Interpolated torque capacity (Nm).
   */
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
  // 1. DISPLAY UNITS & TEMPERATURE CONVERTORS
  // =========================================================================
 
  /** @type {string} Active global temperature unit setting ('C' or 'F'). */
  var tempUnit = 'C';
 
  /**
   * Sets global temperature scale selector.
   * @param {string} unit - Scale designator ('C' or 'F').
   */
  function setTempUnit(unit) {
    if (unit === 'F' || unit === 'C') tempUnit = unit;
  }
 
  /**
   * Retrieves active global temperature scale.
   * @returns {string} Selected unit ('C' or 'F').
   */
  function getTempUnit() { return tempUnit; }
 
  /**
   * Converts standard Celsius temperature values into active selected unit.
   * @param {number} tempC - Input temperature in Celsius (°C).
   * @returns {number} Transformed scalar numerical temperature value.
   */
  function toDisplayTemp(tempC) {
    if (tempUnit === 'F') return (tempC * 9 / 5) + 32;
    return tempC;
  }
 
  /**
   * Formats a Celsius temperature into a rounded string tagged with active scale symbol.
   * @param {number} tempC - Input temperature in Celsius (°C).
   * @returns {string} Formatted string label (e.g., "95°C" or "203°F").
   */
  function formatTemp(tempC) {
    var val = Math.round(toDisplayTemp(tempC));
    return val + '°' + tempUnit;
  }
 
  // =========================================================================
  // 2. SURFACE ZONES & ENVIRONMENT GRIP MODIFIERS
  // =========================================================================
 
  /**
   * Surface table maps governing grip multipliers, rolling resistance, and vibration.
   * @type {Object.<string, Object.<string, {muMul: number, rollMul: number, bumpiness: number}>>}
   */
  var SURFACE_SETS = {
    default: {
      tarmac: { muMul: 1.00, rollMul: 1.0, bumpiness: 0.00 },
      curb:   { muMul: 0.88, rollMul: 1.2, bumpiness: 0.35 },
      runoff: { muMul: 0.70, rollMul: 1.5, bumpiness: 0.15 },
      gravel: { muMul: 0.55, rollMul: 2.0, bumpiness: 0.25 }
    }
  };
 
  /**
   * Registers custom or track-specific surface definition properties.
   * @param {string} name - Surface set identifier name.
   * @param {Object} defs - Surface physical coefficient mapping definitions.
   */
  function registerSurfaceSet(name, defs) { SURFACE_SETS[name] = defs; }
 
  /**
   * Resolves track-defined surface table properties fallback to defaults.
   * @param {Object} track - Target track object instance.
   * @returns {Object} Active surface set parameters table.
   */
  function surfaceSetFor(track) {
    var name = track && track.def && track.def.surfaceSet;
    return (name && SURFACE_SETS[name]) || SURFACE_SETS.default;
  }
 
  /**
   * Evaluates surface type zone depending on perpendicular track lateral offset distance.
   * @param {Object} track - Track object instance.
   * @param {number} d - Absolute perpendicular distance to spline centerline.
   * @returns {string} Identified surface zone name string identifier.
   */
  function surfaceZone(track, d) {
    if (d <= track.HALF_WIDTH) return 'tarmac';
    if (d <= track.CURB_HW) return 'curb';
    if (d <= track.RUNOFF_HW) return 'runoff';
    return 'gravel';
  }
 
  /** @type {number} Ambient atmospheric weather grip multiplier. */
  var weatherGripMul = 1.0;
 
  /**
   * Configures global ambient environmental grip scaling factor.
   * @param {number} mul - Weather grip multiplier scalar (e.g., 0.6 for wet rain).
   */
  function setWeatherGrip(mul) { weatherGripMul = safeNum(mul, 1); }
 
  // =========================================================================
  // 3. TUNING CONFIGURATION
  // =========================================================================
 
  /**
   * Global vehicle parameter configuration tree holding all physical constants.
   */
  var tuning = {
    scale: {
      groundCoverageMult: 1.25,
      baseKmhPerUnit: 0.54
    },
    reference: { topSpeedKmh: 360 },
 
    vehicle: {
      mass: 650,               // Total dry mass (kg)
      cgHeight: 0.15,          // Center of gravity height (m)
      wheelbaseFront: 1.62,    // Distance CG to front axle (m)
      wheelbaseRear: 1.68,     // Distance CG to rear axle (m)
      trackWidth: 1.70,        // Axle width (m)
      yawInertia: 1000,        // Yaw moment of inertia (kg*m^2)
      driveType: 'AWD'         // Drivetrain layout: 'FWD', 'RWD', or 'AWD'
    },
 
    engine: {
      idleRpm: 1200,
      redlineRpm: 12000,
      frictionTorque: 40,
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
      diffLock: 0.35,
      diffCouplingGain: 50,
      reverseTorque: 600,
      awdFrontFraction: 0.60
    },
 
    tires: {
      radius: 0.33,
      inertia: 1.2,
      rollingResistance: 0.010,
      longB: 15, longC: 1.6, longE: -0.3,
      latB: 14, latC: 1.8, latE: 0.0,
      peakMu: 8.50,
      optimalTempC: 95,
      tempWindowC: 40,
      warmupPerKJ: 0.13,          // Longitudinal slip heating — used for BRAKING slip only now
      accelWarmupPerKJ: 0.03,     // Longitudinal slip heating for ACCELERATION/wheelspin — much lower, so throttle alone barely heats the tyre
      corneringWarmupPerKJ: 0.07, // Lateral slip heating factor (cornering) — heats up, but less aggressively than braking does
      coolRatePerSec: 0.10,    // Base air/surface cooling rate
      coolRateVel: 0.0008,     // Speed-linked cooling — lets tyres shed a bit of heat on a straight
      wearPerKJ: 0.000025,     // Wear rate per kJ
      wearGripLoss: 0.30       // Max wear grip penalty (30%)
    },
 
    aero: {
      dragCoeff: 0.45,
      frontalArea: 1.5,
      liftCoeff: 3.5,
      frontAeroBalance: 0.32,
      airDensity: 1.225
    },
 
    brakes: {
      maxTorque: 2600,         // Base brake torque capacity (Nm)
      frontBias: 0.60,         // Front-to-rear distribution
      heatingRate: 1.8,        // Still strong under hard braking
      coolRateBase: 0.03,      // Pulled back up from 0.015 — cooling had gotten so weak the brakes basically never came back down between corners, which kept dumping heat into the tyres via conduction even while just driving
      coolRateVel: 0.0012,     // Pulled back up from 0.0005, for the same reason
      conductionToTire: 0.03,  // Pulled back down from 0.04 — now that tyres have their own accel-vs-braking split, they don't need as much help from brake conduction
      // Temperature Efficiency Curve
      coldTempC: 25,
      coldEfficiency: 0.85,    // Cold brakes have 85% bite
      optimalTempMinC: 300,    // Sweet spot start
      optimalTempMaxC: 500,    // Sweet spot end
      optimalEfficiency: 1.20, // Brakes work extra well (+20% torque) between 300C and 500C
      fadeTempC: 1000,
      fadeEfficiency: 0.60     // Thermal brake fade at 1000C
    },
 
    suspension: {
      weightTransferSmoothing: 6.0,
      rollStiffnessFrontFrac: 0.75
    },
 
    steering: {
      maxAngleDeg: 30,
      speedSensitivity: 0.005,
      rateIn: 3.8,
      rateOut: 6.5
    },
 
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
 
    offTrack: {
      accelMul: 0.55,
      drag: 0.10,
      gripLoss: 0.10,
      gripRecover: 0.001,
      gripFloor: 0.20
    },
 
    surfaces: SURFACE_SETS.default,
    minWheelLoad: 40
  };
 
  // =========================================================================
  // 4. DERIVED CACHE & RECALCULATION
  // =========================================================================
 
  /** @type {Object} Pre-calculated constants derived from current tuning parameters. */
  var d = {};
 
  /**
   * Recalculates derived physics constants and lookup arrays. Must be invoked
   * whenever configuration numbers in `tuning` are modified at runtime.
   */
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
  // 5. EVENT SYSTEM & EXTENSIONS
  // =========================================================================
 
  /** @type {Object.<string, Array<Function>>} Registered physics event listener callbacks. */
  var listeners = {};
 
  /**
   * Attaches an event listener callback to a named physics engine event.
   * @param {string} evt - Event topic name ('wallHit', 'wheelLock', 'wheelSpin', 'gearShift', 'lowFuel').
   * @param {Function} fn - Handler callback target function.
   */
  function on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); }
 
  /**
   * Detaches a previously bound physics event callback handler.
   * @param {string} evt - Target event name.
   * @param {Function} fn - Handler function to unbind.
   */
  function off(evt, fn) {
    var l = listeners[evt]; if (!l) return;
    var i = l.indexOf(fn); if (i !== -1) l.splice(i, 1);
  }
 
  /**
   * Dispatches event notification messages to subscribed listeners safely.
   * @param {string} evt - Event name.
   * @param {*} payload - Associated data object parameter provided to handlers.
   */
  function emit(evt, payload) {
    var l = listeners[evt]; if (!l) return;
    for (var i = 0; i < l.length; i++) { try { l[i](payload); } catch (e) {} }
  }
 
  /** @type {Array<Function>} Registered external hook functions executed per-step. */
  var extensions = [];
 
  /**
   * Registers external custom simulation plugins/extensions executed right after physics calculations.
   * @param {Function} fn - Extension callback function formatted as `fn(car, track, dt)`.
   */
  function registerExtension(fn) { extensions.push(fn); }
 
  // =========================================================================
  // 6. CAR STATE MANAGEMENT
  // =========================================================================
 
  /**
   * Instantiates and initializes a fresh car state object with default starting parameters.
   * @returns {Object} Fresh car state instance data structure.
   */
  function createCar() {
    var amb = tuning.environment.ambientTempC;
    return {
      x: 0, y: 0, angle: 0,
      vf: 0, vl: 0,
      steer: 0,
      wvx: 0, wvy: 0, av: 0,
      gripHealth: 1,
 
      rpm: tuning.engine.idleRpm,
      gear: 1,
      reversing: false,
      shiftCooldown: 0,
 
      wheelOmega: [0, 0, 0, 0],
      wheelLoad: [0, 0, 0, 0],
      wheelSlipRatio: [0, 0, 0, 0],
      wheelSlipAngle: [0, 0, 0, 0],
 
      brakeTemp: [amb, amb, amb, amb],
      tireTemp: [amb + 65, amb + 65, amb + 65, amb + 65], // Starts warm near optimal
      tireWear: [0, 0, 0, 0],
 
      lastAx: 0, lastAy: 0,
      fuel: d.fuelStartL,
      damage: 0,
      telemetry: {}
    };
  }
 
  /**
   * Teleports and resets car dynamic states onto a track grid/start slot configuration.
   * @param {Object} car - Vehicle state reference.
   * @param {{x: number, y: number, angle: number}} slot - Target positioning descriptor.
   */
  function placeAt(car, slot) {
    var amb = tuning.environment.ambientTempC;
    car.x = slot.x; car.y = slot.y; car.angle = slot.angle;
    car.vf = 0; car.vl = 0; car.steer = 0;
    car.wvx = 0; car.wvy = 0; car.av = 0;
    car.gripHealth = 1;
 
    car.rpm = tuning.engine.idleRpm;
    car.gear = 1;
    car.reversing = false;
    car.shiftCooldown = 0; // Fixed from colon to assignment operator
 
    car.wheelOmega = [0, 0, 0, 0];
    car.wheelLoad = [0, 0, 0, 0];
    car.wheelSlipRatio = [0, 0, 0, 0];
    car.wheelSlipAngle = [0, 0, 0, 0];
 
    car.brakeTemp = [amb, amb, amb, amb];
    car.tireTemp = [amb + 65, amb + 65, amb + 65, amb + 65];
    car.tireWear = [0, 0, 0, 0];
 
    car.lastAx = 0; car.lastAy = 0;
    car.fuel = d.fuelStartL;
    car.damage = 0;
    car.telemetry = {};
  }
 
  // =========================================================================
  // 7. THERMAL DYNAMICS HELPERS
  // =========================================================================
 
  /**
   * Calculates current tire friction multiplier based on wear degradation and thermal offset from ideal operating window.
   * @param {number} tempC - Tire carcass temperature in Celsius (°C).
   * @param {number} wear - Wear degradation factor normalized [0..1].
   * @returns {number} Grip multiplier factor bounded within range [0.2, 1.0].
   */
  function tireGripMultiplier(tempC, wear) {
    var tw = tuning.tires;
    var tempLoss = clamp(Math.abs(tempC - tw.optimalTempC) / tw.tempWindowC, 0, 1) * 0.35;
    var wearLoss = wear * tw.wearGripLoss;
    return clamp(1 - tempLoss - wearLoss, 0.20, 1.0);
  }
 
  /**
   * Evaluates brake torque efficiency multiplier across thermal operational ranges.
   * @param {number} tempC - Current brake rotor temperature in Celsius (°C).
   * @returns {number} Torque scaling multiplier (e.g. 1.20 in peak sweet spot between 300°C–500°C).
   */
  function brakeEfficiency(tempC) {
    var b = tuning.brakes;
    // Cold brake ramp-up to sweet spot
    if (tempC < b.optimalTempMinC) {
      var tCold = clamp((tempC - b.coldTempC) / (b.optimalTempMinC - b.coldTempC), 0, 1);
      return lerp(b.coldEfficiency, b.optimalEfficiency, tCold);
    }
    // Optimal 300C - 500C range (+20% efficiency boost)
    if (tempC <= b.optimalTempMaxC) {
      return b.optimalEfficiency;
    }
    // Overheating brake fade (500C up to 1000C)
    var tFade = clamp((tempC - b.optimalTempMaxC) / (b.fadeTempC - b.optimalTempMaxC), 0, 1);
    return lerp(b.optimalEfficiency, b.fadeEfficiency, tFade);
  }
 
  // =========================================================================
  // 8. CORE INTEGRATION & SUBSTEPPING
  // =========================================================================
 
  /** @type {number} Fixed maximum step integration interval limit (120 Hz). */
  var MAX_SUBSTEP = 1 / 120;
 
  /**
   * Advances single fixed sub-step iteration of vehicle physical dynamics logic.
   * @param {Object} car - Target car object state.
   * @param {Object.<string, boolean>} keys - Active driver key input map.
   * @param {Object} track - Track geometry and surface model instance.
   * @param {number} dt - Sub-step delta time interval (seconds).
   * @returns {{info: Object, prevX: number, prevY: number, offTrack: boolean}} Step result output state.
   */
  function substep(car, keys, track, dt) {
    var V = tuning.vehicle, E = tuning.engine, DT = tuning.drivetrain, TP = tuning.tires,
        A = tuning.aero, B = tuning.brakes, ST = tuning.steering, AS = tuning.assists,
        ENV = tuning.environment, SUS = tuning.suspension, OT = tuning.offTrack;
 
    // STEP A: Surface & Off-Track Detection
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
 
    var frameScale = dt * 60;
    if (offTrack) {
      vf -= vf * OT.drag * dt;
      car.gripHealth = Math.max(OT.gripFloor, car.gripHealth - OT.gripLoss * frameScale);
    } else {
      car.gripHealth = Math.min(1.0, car.gripHealth + OT.gripRecover * frameScale);
    }
 
    var vxSafe = Math.abs(vf) < 0.6 ? (vf >= 0 ? 0.6 : -0.6) : vf;
 
    // STEP B: Steering Angles
    var maxAngle = deg2rad(ST.maxAngleDeg) / (1 + Math.abs(vf) * ST.speedSensitivity);
    var steerTarget = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    var rate = (steerTarget === 0) ? ST.rateOut : ST.rateIn;
    car.steer += (steerTarget - car.steer) * clamp(rate * dt, 0, 1);
    if (Math.abs(car.steer) < 0.001) car.steer = 0;
    var delta = car.steer * maxAngle;
 
    var vlF = vl + av * a, vlR = vl - av * b;
    var absVx = Math.abs(vxSafe);
    var dir = sign(vxSafe) || 1;
    var alphaF = clamp(delta * dir - Math.atan2(vlF, absVx), -1.3, 1.3);
    var alphaR = clamp(-Math.atan2(vlR, absVx), -1.3, 1.3);
 
    // STEP C: Load Transfer
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
      Math.max(minLoad, wf / 2 + latF),
      Math.max(minLoad, wf / 2 - latF),
      Math.max(minLoad, wr / 2 + latR),
      Math.max(minLoad, wr / 2 - latR)
    ];
    car.wheelLoad = loads;
 
    // STEP D: Tire Grip Multipliers
    var muEff = [0, 0, 0, 0];
    for (var wi = 0; wi < 4; wi++) {
      muEff[wi] = TP.peakMu * zoneDef.muMul * weatherGripMul * car.gripHealth *
        tireGripMultiplier(car.tireTemp[wi], car.tireWear[wi]);
    }
 
    // STEP E: Throttle, Transmission & Brakes
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
 
      if (V.driveType === 'AWD') {
        var frontTotal = wheelTorqueTotal * DT.awdFrontFraction;
        var rearTotal = wheelTorqueTotal * (1 - DT.awdFrontFraction);
        applyDiff(driveTorque, [0, 1], frontTotal, car, DT);
        applyDiff(driveTorque, [2, 3], rearTotal, car, DT);
      } else {
        applyDiff(driveTorque, drivenIdx, wheelTorqueTotal, car, DT);
      }
 
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
 
    // Dynamic Braking with Temperature Efficiency Multiplier
    var brakeTorque = [0, 0, 0, 0];
    if (brakeIn && !car.reversing) {
      var frontBase = B.maxTorque * B.frontBias * brakeIn / 2;
      var rearBase = B.maxTorque * (1 - B.frontBias) * brakeIn / 2;
 
      // Apply brake temperature efficiency curve (Boosts around 300C-500C)
      brakeTorque = [
        frontBase * brakeEfficiency(car.brakeTemp[0]),
        frontBase * brakeEfficiency(car.brakeTemp[1]),
        rearBase  * brakeEfficiency(car.brakeTemp[2]),
        rearBase  * brakeEfficiency(car.brakeTemp[3])
      ];
 
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
 
    // STEP F: Wheel Forces & Thermal Dynamics
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
 
      if (bumpAmp > 0) fyWheel += (Math.random() - 0.5) * bumpAmp * loads[i] * 0.08;
 
      var rr = -sign(kappaRef) * TP.rollingResistance * zoneDef.rollMul * loads[i];
      fxWheel += rr;
 
      var fxBodyWheel, fyBodyWheel;
      if (isFront) {
        fxBodyWheel = fxWheel * Math.cos(delta) - fyWheel * Math.sin(delta);
        fyBodyWheel = fxWheel * Math.sin(delta) + fyWheel * Math.cos(delta);
      } else {
        fxBodyWheel = fxWheel; fyBodyWheel = fyWheel;
      }
 
      FxBody += fxBodyWheel; FyBody += fyBodyWheel;
      Mtotal += offsets[i][0] * fyBodyWheel - offsets[i][1] * fxBodyWheel;
 
      var reactionTorque = fxWheel * TP.radius;
      var domega = (driveTorque[i] - sign(car.wheelOmega[i]) * brakeTorque[i] - reactionTorque) / TP.inertia;
      car.wheelOmega[i] += domega * dt;
 
      // -------------------------------------------------------------------
      // THERMAL & WEAR COMPUTATION
      // -------------------------------------------------------------------
      // Longitudinal slip (braking/acceleration) and lateral slip (cornering)
      // are tracked separately so each situation heats the tyre differently:
      // straight-line running generates almost neither and lets the tyre cool,
      // turning brings in some heat through the lateral term, and braking
      // brings in more heat through both the longitudinal term AND the hot
      // brakes conducting into the tyre carcass below.
      var slipPowerLongW = Math.abs(fxWheel * kappa * kappaRef);
      var slipPowerLatW = Math.abs(fyWheel * alpha * kappaRef);
      var slipEnergyLongKJ = slipPowerLongW * dt / 1000;
      var slipEnergyLatKJ = slipPowerLatW * dt / 1000;
      var slipEnergyKJ = slipEnergyLongKJ + slipEnergyLatKJ;
      totalSlipEnergy += slipEnergyKJ;
      totalDriveWork += Math.abs(driveTorque[i] * car.wheelOmega[i]) * dt / 1000;
 
      // 1. BRAKE THERMALS (Can reach ~1000°C under hard braking)
      var brakePowerW = brakeTorque[i] * Math.abs(car.wheelOmega[i]);
      var brakeEnergyKJ = brakePowerW * dt / 1000;
      var brakeHeatRise = brakeEnergyKJ * B.heatingRate;
      var brakeCooling = (car.brakeTemp[i] - ENV.ambientTempC) * (B.coolRateBase + Math.abs(vf) * B.coolRateVel) * dt;
      car.brakeTemp[i] += brakeHeatRise - brakeCooling;
      car.brakeTemp[i] = clamp(car.brakeTemp[i], ENV.ambientTempC, 1200);
 
      // 2. TIRE THERMALS (Can reach ~120°C under severe braking/slip)
      var brakeConduction = Math.max(0, car.brakeTemp[i] - car.tireTemp[i]) * B.conductionToTire * dt;
      // kappa < 0 means the wheel is turning slower than the road (braking/lockup);
      // kappa >= 0 means it's turning faster (drive/wheelspin) — weight each differently
      // so throttle alone barely warms the tyre while braking clearly does.
      var longWeight = (kappa < 0) ? TP.warmupPerKJ : TP.accelWarmupPerKJ;
      var tireFrictionHeat = slipEnergyLongKJ * longWeight + slipEnergyLatKJ * TP.corneringWarmupPerKJ;
      var tireCooling = (car.tireTemp[i] - ENV.ambientTempC) * (TP.coolRatePerSec + Math.abs(vf) * TP.coolRateVel) * dt;
      car.tireTemp[i] += tireFrictionHeat + brakeConduction - tireCooling;
      car.tireTemp[i] = clamp(car.tireTemp[i], -20, 200);
 
      // 3. TIRE WEAR
      var tempAbuseMul = (car.tireTemp[i] > TP.optimalTempC + TP.tempWindowC) ? 1.8 : 1.0;
      car.tireWear[i] = clamp(car.tireWear[i] + slipEnergyKJ * TP.wearPerKJ * tempAbuseMul, 0, 1.0);
 
      car.wheelSlipRatio[i] = kappa;
      car.wheelSlipAngle[i] = alpha;
    }
 
    // Aerodynamics
    var windForwardComp = ENV.windX * Math.cos(car.angle) + ENV.windZ * Math.sin(car.angle);
    var relVf = vf - windForwardComp;
    var drag = 0.5 * A.airDensity * A.dragCoeff * A.frontalArea * relVf * Math.abs(relVf);
    FxBody -= drag;
 
    // ESC
    if (AS.stabilityControl) {
      var yawDemand = Math.abs(delta) > 0.001 ? (vxSafe / Math.max(a + b, 0.1)) * Math.tan(delta) : 0;
      var yawError = av - yawDemand;
      Mtotal -= yawError * AS.escGain * d.yawInertia * 1.5;
    }
 
    // STEP G: Integration
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
 
    var fwX = Math.cos(car.angle), fwY = Math.sin(car.angle);
    var rgX = -Math.sin(car.angle), rgY = Math.cos(car.angle);
    var wvx = fwX * car.vf + rgX * car.vl;
    var wvy = fwY * car.vf + rgY * car.vl;
    var prevX = car.x, prevY = car.y;
    car.x += wvx * dt;
    car.y += wvy * dt;
 
    // STEP H: Barrier Impacts
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
 
    // STEP I: Telemetry
    var fuelUsed = (totalDriveWork + totalSlipEnergy * 0.15) * tuning.fuel.consumptionPerKJ;
    car.fuel = Math.max(0, car.fuel - fuelUsed);
    if (car.fuel < d.fuelStartL * 0.1) emit('lowFuel', { car: car, fuel: car.fuel });
 
    car.telemetry = {
      rpm: car.rpm,
      gear: car.reversing ? -1 : car.gear,
      surface: zone,
      loads: loads.slice(),
      slipRatio: car.wheelSlipRatio.slice(),
      slipAngle: car.wheelSlipAngle.slice(),
      brakeTemp: car.brakeTemp.slice(),
      tireTemp: car.tireTemp.slice(),
      formattedBrakeTemp: car.brakeTemp.map(formatTemp),
      formattedTireTemp: car.tireTemp.map(formatTemp),
      tireWear: car.tireWear.slice(),
      fuel: car.fuel,
      gripHealth: car.gripHealth,
      tempUnit: tempUnit
    };
 
    return { info: info, prevX: prevX, prevY: prevY, offTrack: offTrack };
  }
 
  /**
   * Distributes drive torque output across an axle pair accounting for differential lock resistance.
   * @param {Array<number>} driveTorque - Array holding per-wheel target engine drive torques (Nm).
   * @param {Array<number>} idxPair - Axle pair wheel indices (e.g. [0,1] or [2,3]).
   * @param {number} total - Total drive torque allocated to this axle pair (Nm).
   * @param {Object} car - Car reference data structure.
   * @param {Object} DT - Transmission and drivetrain tuning configuration block.
   */
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
  // 9. PUBLIC INTEGRATOR STEP ENTRYPOINT
  // =========================================================================
 
  /**
   * Advances simulation frame time by fixed substeps and triggers extension callbacks.
   * @param {Object} car - Car state model instance.
   * @param {Object.<string, boolean>} keys - Active key controls state.
   * @param {Object} track - Active track environment instance.
   * @param {number} dt - Variable delta frame time (seconds).
   * @returns {{info: Object, prevX: number, prevY: number, offTrack: boolean}} Integration output descriptor.
   */
  function step(car, keys, track, dt) {
    dt = clamp(safeNum(dt, 0), 0, 0.1);
    var n = Math.max(1, Math.ceil(dt / MAX_SUBSTEP));
    var sub = dt / n;
    var prevX = car.x, prevY = car.y;
    var lastResult = null;
 
    for (var s = 0; s < n; s++) {
      lastResult = substep(car, keys, track, sub);
    }
 
    for (var e = 0; e < extensions.length; e++) {
      try { extensions[e](car, track, dt); } catch (err) {}
    }
 
    return lastResult || { info: track.nearestTrackInfo(car.x, car.y), prevX: prevX, prevY: prevY, offTrack: false };
  }
 
  /**
   * Calculates car forward/lateral linear speed in km/h.
   * @param {Object} car - Target car object.
   * @returns {number} Speed scalar value (km/h).
   */
  function speedKmh(car) {
    if (!car) return 0;
    var mps = Math.hypot(car.vf, car.vl) * d.mpsPerUnit;
    return mps * 3.6;
  }
 
  /**
   * Calculates normalized ratio of vehicle speed relative to top speed capacity reference [0..1].
   * @param {Object} car - Target car object state.
   * @returns {number} Speed fraction scalar ratio.
   */
  function speedFraction(car) {
    if (!car) return 0;
    return clamp(speedKmh(car) / tuning.reference.topSpeedKmh, 0, 1);
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
    // Unit Switcher Methods (Call from Menu/Settings UI)
    setTempUnit: setTempUnit,
    getTempUnit: getTempUnit,
    formatTemp: formatTemp,
    toDisplayTemp: toDisplayTemp
  };
})();
