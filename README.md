# Circuit Racer 3D — file layout

Open `index.html` in a browser. No build step, no server needed — the files
load as plain scripts, so double-clicking works.

## Where to change what

| I want to change… | Edit |
|---|---|
| Laps, countdown, max players, sky colour, camera, fog, net send rate | `js/config.js` |
| Track shapes — **add a track here** | `js/tracks.js` |
| Car colours — **add a livery here** | `js/liveries.js` |
| Grip, acceleration, braking, steering, top speed, off-track penalty | `js/physics.js` |
| The shape of the car itself | `js/car-model.js` |
| Tarmac / kerb / barrier / fence geometry | `js/track-scene.js` |
| Grandstands, trees, lake, city skyline | `js/scenery.js` |
| Lap counter, speedo, positions panel, results, name tags | `js/hud.js` |
| Menu screens and the track/livery pickers | `js/menus.js` |
| Hosting, joining, lobby, clock sync, dead reckoning | `js/multiplayer.js` |
| Race state machine, input, main loop | `js/game.js` |
| Page markup | `index.html` |
| All styling | `css/style.css` |

Nothing is duplicated between files, so each change is made in exactly one
place.

## Adding a track

Open `js/tracks.js` and add a block:

```js
{
  id: 'monaco',
  name: 'Monaco',
  place: 'Monte Carlo',
  available: true,
  points: [
    [0, 0], [1500, -200], [2400, -1100], [2000, -2300]
    // …12–30 points, in the driving direction, loop closes automatically
  ]
}
```

That is the whole job. The tarmac, kerbs, run-off, barriers, catch fencing,
start/finish line, starting grid, grandstands, trees and skyline are all
generated from the points, and the track appears in the menu automatically.

Optional extras on the same block: `width`, `curbWidth`, `runoffWidth`,
`smoothing`, and `scenery: { lake, lakeShrink, city, trees, grandstands }`.
Set `available: false` to show it greyed out as "coming soon".

Coordinates are `[x, z]` in world units; the first point is the start/finish
line. Roughly 1000 units is a medium straight at the default 170-unit width.

## Adding a livery

Open `js/liveries.js` and add a block with three colours: `primary` (bodywork),
`accent` (nose tip, sidepod stripe) and `trim` (nose stripe, wing endplates).
It shows up in the single-player picker and the multiplayer lobby by itself.

## How the modules talk to each other

Everything hangs off one global, `GAME`. There is one shared snapshot of what
is happening right now, `GAME.State` (owned by `game.js`), and each module
exposes a small set of functions:

```
config.js          GAME.Config          settings
tracks.js          GAME.Tracks          track data
liveries.js        GAME.Liveries        livery data
track-geometry.js  GAME.TrackGeometry   coordinates -> drivable circuit maths
track-scene.js     GAME.TrackScene      circuit maths -> meshes
scenery.js         GAME.Scenery         meshes around the circuit
car-model.js       GAME.CarModel        the 3D car
physics.js         GAME.Physics         handling (.tuning holds every number)
hud.js             GAME.Hud             on-screen readouts
menus.js           GAME.Menus           screens and pickers
multiplayer.js     GAME.Net             hosting, joining, sync
game.js            GAME.Game, GAME.State  state machine and main loop
```

Load order matters and is set in `index.html`; a new module goes before
`game.js`.

## Notes on multiplayer

The host picks the track in the lobby and it is sent to everyone at lights-out,
so the whole grid always races the same circuit.
