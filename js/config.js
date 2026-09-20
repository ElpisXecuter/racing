/* ===========================================================================
   config.js — global game settings
   ---------------------------------------------------------------------------
   Everything here is "how the game is set up", not "how a car behaves"
   (physics.js) or "what a track looks like" (tracks.js).
   Change a number here and it takes effect everywhere.
   =========================================================================== */

window.GAME = window.GAME || {};

GAME.Config = {

  // ---- Race rules ----------------------------------------------------------
  race: {
    totalLaps: 3,
    countdownMs: 3000,       // solo lights-out countdown
    maxPlayers: 8
  },

  // ---- Default track dimensions (a track in tracks.js can override these) ---
  track: {
    width: 170,              // tarmac width in world units
    curbWidth: 16,           // red/white kerb either side of the tarmac
    runoffWidth: 95,         // grey run-off outside the kerbs
    barrierGap: 8,           // gap between run-off and the barrier wall
    barrierHeight: 8,
    fenceHeight: 34,
    carRadius: 17,           // used for wall collision
    // smoothing applied to the raw coordinates you type into tracks.js
    smoothing: { chaikin: 10, relaxPasses: 26, relaxStrength: 0.3, samples: 2000 }
  },

  // ---- Colours of the track surface ---------------------------------------
  trackColors: {
    tarmac: 0x2b2c30,
    runoff: 0x75787e,
    kerbA: 0xd21f1f,
    kerbB: 0xf2f2f2,
    kerbStripeLen: 55,
    edgeLine: 0xf4f4f4,
    barrierA: 0xd21f1f,
    barrierB: 0xf2f2f2,
    barrierStripeLen: 70,
    fenceMesh: 0xc8d2db,
    fenceRail: 0x2f3640
  },

  // ---- World / sky ---------------------------------------------------------
  world: {
    sky: 0x9fd6ef,
    fogNear: 900,
    fogFar: 6800,
    groundColor: 0x2e7d3e,
    groundWidth: 17000,
    groundDepth: 14000,
    ambientLight: 0.7,
    sunLight: 0.75
  },

  // ---- Chase camera --------------------------------------------------------
  camera: {
    fov: 62,
    near: 1,
    far: 9000,
    distanceBehind: 100,
    height: 44,
    lookAhead: 34,
    lookHeight: 9,
    followSmoothing: 0.0012,  // lower = snappier follow
    shake: { speed: 22, amplitude: 3.2, easeIn: 6 }
  },

  // ---- Networking ----------------------------------------------------------
  net: {
    sendHz: 30,               // state packets per second
    standingsInterval: 0.2,   // seconds between standings refreshes
    startBufferMs: 1200,      // head-room so lights-out lands on every screen together
    maxExtrapolate: 0.45,     // seconds of dead-reckoning before a car is frozen
    smoothing: 24
  },

  // ---- Speedometer units ---------------------------------------------------
  units: [
    { id: 'kmh', name: 'km/h', mph: false },
    { id: 'mph', name: 'mph', mph: true }
  ],

  // ---- Name labels above cars ---------------------------------------------
  labels: { height: 27, opacity: 0.55, scale: [52, 13] }
};
