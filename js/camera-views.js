/* ===========================================================================
   camera-views.js — the camera modes you can cycle through with C, plus the
   hold-Space look-back
   ---------------------------------------------------------------------------
   Three modes, cycled in order: chase (the default trailing camera, handled
   by game.js's existing updateCamera) -> cockpit (driver's eye view) -> nose
   (a camera mounted on the front of the car). This module only owns the
   cockpit/nose math and the mode state; game.js still owns the chase camera
   itself and just asks this module which mode is active.

   Coordinates for the mount points below are local car-space, matching
   car-model.js: +X is forward, +Y is up, +Z is to the right, and the car is
   roughly 62 units long.
   =========================================================================== */

GAME.CameraViews = (function () {
  'use strict';

  var MODES = ['chase', 'cockpit', 'nose'];
  var modeIndex = 0;

  function cycle() {
    modeIndex = (modeIndex + 1) % MODES.length;
    return MODES[modeIndex];
  }
  function current() { return MODES[modeIndex]; }
  function reset() { modeIndex = 0; }
  function isOnboard() { return MODES[modeIndex] !== 'chase'; }

  // Where each onboard camera is mounted, in local car-space.
  var MOUNTS = {
    cockpit: { x: 2.5, y: 7.7, z: 0 },   // driver's eyes, just behind the halo/windscreen
    nose:    { x: 30, y: 5.4, z: 0 }     // just behind the nose tip
  };
  var LOOK_DIST = 45; // how far ahead (or behind, when looking back) each onboard camera aims

  // Local car-space offset -> world position, given the car's world
  // position/heading. Mirrors how the car mesh itself is oriented in
  // game.js (carGroup.rotation.y = -car.angle).
  function localToWorld(car, lx, ly, lz) {
    var fx = Math.cos(car.angle), fz = Math.sin(car.angle);
    return {
      x: car.x + lx * fx - lz * fz,
      y: ly,
      z: car.y + lx * fz + lz * fx
    };
  }

  // Positions and aims the camera at the current onboard mount. Onboard
  // views are rigidly attached to the car (no follow lag) — they just look
  // wherever the nose is pointing, or backward while lookBack is held.
  // jx/jy/jz are the same off-track shake jitter the chase camera uses, so
  // the ride feels consistent no matter which view is active.
  function applyOnboard(camera, car, lookBack, jx, jy, jz) {
    var mount = MOUNTS[current()];
    if (!mount) return false;

    var pos = localToWorld(car, mount.x, mount.y, mount.z);
    var aimX = lookBack ? mount.x - LOOK_DIST : mount.x + LOOK_DIST;
    var look = localToWorld(car, aimX, mount.y, mount.z);

    camera.position.set(pos.x + jx, pos.y + jy, pos.z + jz);
    camera.lookAt(look.x + jx, look.y + jy, look.z + jz);
    return true;
  }

  return {
    cycle: cycle,
    current: current,
    reset: reset,
    isOnboard: isOnboard,
    applyOnboard: applyOnboard
  };
})();
