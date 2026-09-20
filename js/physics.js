/* ===========================================================================
   physics.js — how the car drives
   ---------------------------------------------------------------------------
   Every number that affects handling lives in `tuning` below. Change one and
   the whole game changes; nothing else needs editing.

   Units: most values are written in real-world terms (km/h, m/s²) and are
   converted to world units automatically, so "top speed 360 km/h" and
   "braking at 30 m/s²" are literal rather than just a feel.

   If you change a value in `tuning` while the game is running, call
   GAME.Physics.refresh() to recompute the derived values.
   =========================================================================== */

GAME.Physics = (function () {
  'use strict';

  var tuning = {

    // ---- scale ----
    // Stretches world distance per unit of displayed speed: the speedometer
    // still reads the same, but the car covers more track for that number.
    groundCoverageMult: 1.25,
    baseKmhPerUnit: 0.54,          // km/h per world-unit/sec before the multiplier

    // ---- straight-line speed ----
    topSpeedKmh: 360,
    reverseSpeedUnits: 60,         // ≈32 km/h backwards
    accelPeak: 15,                 // m/s² off the line (~2.65 g)
    accelTail: 2,                  // m/s² still available near top speed
    accelFalloff: 0.75,            // lower = acceleration dies off sooner
    brakeDecel: 30,                // m/s² under braking (~4.9 g)
    reverseAccel: 5,               // m/s²
    dragDecel: 2.2,                // m/s² coasting (engine braking + rolling)

    // ---- steering ----
    turnRate: 2.75,                // higher = tighter turning circle
    steerIn: 4.25,                 // how fast the wheel turns toward lock
    steerOut: 7.0,                 // how fast it self-centres
    lowSpeedFadeUnits: 70,         // below this speed steering fades in

    // ---- grip ----
    cornerGripTrack: 90,           // m/s² of lateral grip on tarmac
    cornerGripGrass: 20,           // m/s² once off the tarmac
    cornerScrub: 3,                // m/s² speed bleed while cornering hard
    slideScrub: 12,                // m/s² extra bleed once the tyres let go
    trackGripBase: 0.0004,         // lateral velocity retained per second (lower = more grip)
    grassGripBase: 0.02,
    slipGripBase: 0.1,             // how loose the rear feels mid-slide
    slideKick: 19,                 // how hard refused steering kicks the tail out
    slideKickGain: 3.0,
    maxLateralUnits: 260,

    // ---- off track ----
    offTrackAccelMul: 0.55,        // throttle effectiveness on grass
    offTrackDrag: 0.1,             // extra speed scrub per second off the tarmac
    offTrackGripRecover: 0.001,    // grip regained per frame back on tarmac
    offTrackGripLoss: 0.1,         // grip lost per frame off the tarmac
    offTrackGripFloor: 0.2,        // worst grip multiplier you can drop to

    // ---- barrier contact ----
    wallBounce: 1.4,
    wallSpeedKeep: 0.85
  };

  // Derived values — recomputed from `tuning`, don't edit these directly.
  var d = {};
  function refresh() {
    d.kmhPerUnit = tuning.baseKmhPerUnit / tuning.groundCoverageMult;
    d.mpsPerUnit = d.kmhPerUnit / 3.6;
    d.maxSpeed = Math.round(tuning.topSpeedKmh / d.kmhPerUnit);
    d.maxReverse = tuning.reverseSpeedUnits * tuning.groundCoverageMult;
    d.accelPeak = tuning.accelPeak / d.mpsPerUnit;
    d.accelTail = tuning.accelTail / d.mpsPerUnit;
    d.brakeDecel = tuning.brakeDecel / d.mpsPerUnit;
    d.reverseAccel = tuning.reverseAccel / d.mpsPerUnit;
    d.dragDecel = tuning.dragDecel / d.mpsPerUnit;
    d.cornerGripTrack = tuning.cornerGripTrack / d.mpsPerUnit;
    d.cornerGripGrass = tuning.cornerGripGrass / d.mpsPerUnit;
    d.cornerScrub = tuning.cornerScrub / d.mpsPerUnit;
    d.slideScrub = tuning.slideScrub / d.mpsPerUnit;
    d.lowSpeedFade = tuning.lowSpeedFadeUnits * tuning.groundCoverageMult;
    d.maxLateral = tuning.maxLateralUnits * tuning.groundCoverageMult;
    d.slideKick = tuning.slideKick * tuning.groundCoverageMult;
  }
  refresh();

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // wvx/wvy/av are world-space velocity and turn rate. They exist so
  // multiplayer peers can dead-reckon this car forward instead of drawing it
  // wherever it was when the last packet left.
  function createCar() {
    return {
      x: 0, y: 0, angle: 0,
      vf: 0, vl: 0, steer: 0,
      wvx: 0, wvy: 0, av: 0,
      gripHealth: 1        // drops while off track, recovers on tarmac
    };
  }

  function placeAt(car, slot) {
    car.x = slot.x; car.y = slot.y; car.angle = slot.angle;
    car.vf = 0; car.vl = 0; car.steer = 0;
    car.wvx = 0; car.wvy = 0; car.av = 0;
    car.gripHealth = 1;
  }

  /* One physics step.
     Returns { info, prevX, prevY, offTrack } so the race logic in game.js can
     handle lap counting without physics needing to know about laps. */
  function step(car, keys, track, dt) {
    var forwardVec = { x: Math.cos(car.angle), y: Math.sin(car.angle) };
    var rightVec = { x: -Math.sin(car.angle), y: Math.cos(car.angle) };

    var info0 = track.nearestTrackInfo(car.x, car.y);
    var offTrack = info0.point.d > track.HALF_WIDTH - 4;
    var accelMul = offTrack ? tuning.offTrackAccelMul : 1.0;

    // ---- throttle / brake ----
    if (keys.up) {
      // Strong off the line, then tapering: the tail is sized so that leaving
      // a corner at ~180 km/h you top out right at the end of the longest
      // straight — top speed is real and reachable, but only there.
      var speedFrac = clamp(Math.abs(car.vf) / d.maxSpeed, 0, 1);
      var curveAccel = d.accelPeak * (1 - Math.pow(speedFrac, tuning.accelFalloff)) + d.accelTail;
      car.vf += curveAccel * accelMul * dt;
    } else if (keys.down) {
      if (car.vf > 5) car.vf -= d.brakeDecel * dt;
      else car.vf -= d.reverseAccel * accelMul * dt;
    } else {
      var dragSign = car.vf > 0 ? -1 : (car.vf < 0 ? 1 : 0);
      var dragAmt = d.dragDecel * dt;
      if (Math.abs(car.vf) <= dragAmt) car.vf = 0;
      else car.vf += dragSign * dragAmt;
    }
    car.vf = clamp(car.vf, -d.maxReverse, d.maxSpeed);

    // grass/run-off scrubs speed on top of the reduced acceleration above, and
    // temporarily dirties the tyres so grip doesn't come straight back
    if (offTrack) {
      car.vf -= car.vf * tuning.offTrackDrag * dt;
      car.gripHealth = Math.max(tuning.offTrackGripFloor, car.gripHealth - tuning.offTrackGripLoss);
    } else {
      car.gripHealth = Math.min(1, car.gripHealth + tuning.offTrackGripRecover);
    }

    // ---- steering input ----
    var steerTarget = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    var rate = (steerTarget === 0) ? tuning.steerOut : tuning.steerIn;
    car.steer += (steerTarget - car.steer) * clamp(rate * dt, 0, 1);
    if (Math.abs(car.steer) < 0.001) car.steer = 0;

    var speedNorm = clamp(Math.abs(car.vf) / d.maxSpeed, 0, 1);
    var lowSpeedFade = clamp(Math.abs(car.vf) / d.lowSpeedFade, 0, 1);

    // ---- friction circle ----
    // rawOmega is the turn rate the driver is asking for; requiredLat is the
    // lateral acceleration it would take to deliver it at this speed. Below the
    // grip ceiling that is exactly what happens. Past it the nose stops turning
    // as sharply as asked and the tail steps out instead — so carrying too much
    // speed into a corner costs you the corner rather than being free.
    var rawOmega = car.steer * tuning.turnRate * lowSpeedFade * (car.vf < 0 ? -1 : 1);
    var gripLimit = offTrack ? d.cornerGripGrass : d.cornerGripTrack * car.gripHealth;
    var requiredLat = Math.abs(car.vf) * Math.abs(rawOmega);
    var overExcess = gripLimit > 0 ? Math.max(0, requiredLat / gripLimit - 1) : 0;
    var actualOmega = rawOmega;
    if (overExcess > 0) {
      var maxOmegaMag = gripLimit / Math.max(Math.abs(car.vf), 1e-4);
      actualOmega = Math.min(Math.abs(rawOmega), maxOmegaMag) * (rawOmega < 0 ? -1 : 1);
    }
    var angleBefore = car.angle;
    car.angle += actualOmega * dt;
    car.av = dt > 0 ? (car.angle - angleBefore) / dt : 0;

    // speed always bleeds off cornering hard, and much more once sliding
    var cornerLoad = Math.abs(car.steer) * speedNorm;
    var slipMix = clamp(overExcess, 0, 1);
    var scrubAccel = d.cornerScrub * cornerLoad + d.slideScrub * slipMix;
    if (scrubAccel > 0) {
      var scrubAmt = scrubAccel * dt;
      if (Math.abs(car.vf) <= scrubAmt) car.vf = 0;
      else car.vf -= (car.vf > 0 ? 1 : -1) * scrubAmt;
    }

    forwardVec = { x: Math.cos(car.angle), y: Math.sin(car.angle) };
    rightVec = { x: -Math.sin(car.angle), y: Math.cos(car.angle) };

    // Grip gets looser the further past the limit you are, so a bad slide has
    // to actually be caught rather than snapping back to grippy.
    var baseGripGround = offTrack ? tuning.grassGripBase : tuning.trackGripBase;
    var gripBase = baseGripGround + (tuning.slipGripBase - baseGripGround) * slipMix;
    car.vl *= Math.pow(gripBase, dt);

    var vx = forwardVec.x * car.vf + rightVec.x * car.vl;
    var vy = forwardVec.y * car.vf + rightVec.y * car.vl;

    var prevX = car.x, prevY = car.y;
    car.x += vx * dt;
    car.y += vy * dt;

    // Whatever steering the grip ceiling refused to turn into rotation shows
    // up here instead, as an actual slide.
    var slideKickMult = 1 + tuning.slideKickGain * clamp(overExcess, 0, 2.5);
    car.vl += car.steer * -d.slideKick * lowSpeedFade * slideKickMult * dt * (car.vf < 0 ? -1 : 1);
    car.vl = clamp(car.vl, -d.maxLateral * slideKickMult, d.maxLateral * slideKickMult);

    // ---- barrier collision (grass and run-off stay drivable) ----
    var info = track.nearestTrackInfo(car.x, car.y);
    var dd = info.point.d;
    var limit = track.BARRIER_HW - track.CAR_RADIUS;
    if (dd > limit) {
      var nx = (car.x - info.point.x) / (dd || 1);
      var ny = (car.y - info.point.y) / (dd || 1);
      car.x = info.point.x + nx * limit;
      car.y = info.point.y + ny * limit;
      var outward = vx * nx + vy * ny;
      if (outward > 0) {
        vx -= nx * outward * tuning.wallBounce;
        vy -= ny * outward * tuning.wallBounce;
        car.vf = vx * forwardVec.x + vy * forwardVec.y;
        car.vl = vx * rightVec.x + vy * rightVec.y;
      }
      car.vf *= tuning.wallSpeedKeep;
    }

    // world-space velocity, for remote extrapolation
    car.wvx = Math.cos(car.angle) * car.vf - Math.sin(car.angle) * car.vl;
    car.wvy = Math.sin(car.angle) * car.vf + Math.cos(car.angle) * car.vl;

    return { info: info, prevX: prevX, prevY: prevY, offTrack: offTrack };
  }

  function speedKmh(car) { return Math.hypot(car.vf, car.vl) * d.kmhPerUnit; }
  function speedFraction(car) { return clamp(Math.abs(car.vf) / d.maxSpeed, 0, 1); }

  return {
    tuning: tuning,
    derived: d,
    refresh: refresh,
    clamp: clamp,
    createCar: createCar,
    placeAt: placeAt,
    step: step,
    speedKmh: speedKmh,
    speedFraction: speedFraction
  };
})();
