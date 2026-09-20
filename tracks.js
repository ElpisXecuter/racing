/* ===========================================================================
   tracks.js — the track catalogue
   ---------------------------------------------------------------------------
   TO ADD A TRACK: copy one of the blocks below, give it an id, a name, and a
   list of [x, z] coordinates. That is genuinely all that is required — the
   tarmac, kerbs, run-off, barriers, fencing, start/finish line, starting grid,
   lake, grandstands, trees and city skyline are all generated from the points.

   Coordinates:
     - Any scale works, but ~1000 units ≈ a medium straight at the default
       track width of 170. Albert Park below spans roughly 8000 x 4000.
     - List them in the driving direction. The loop closes automatically, so
       do not repeat the first point at the end.
     - The first point is the start/finish line.
     - 12-30 points is plenty; the corners are rounded for you.

   Optional per-track overrides (leave any of them out to use Config defaults):
     width       tarmac width
     curbWidth / runoffWidth
     smoothing   { chaikin, relaxPasses, relaxStrength, samples }
     scenery     { lake, lakeShrink, city, trees, grandstands }
     available   set false to show it greyed out as "coming soon"
   =========================================================================== */

GAME.Tracks = [

  {
    id: 'albertpark',
    name: 'Albert Park',
    place: 'Melbourne',
    available: true,
    points: [
      [2500, -650], [1300, -650], [1350, -1400], [-1250, -2000], [-1000, -2500],
      [-1500, -3000], [-1300, -4500], [-1000, -4550], [-500, -4750], [1000, -4300],
      [2700, -2750], [4500, -2500], [4600, -3100], [5750, -2900], [7000, -2500],
      [6600, -2000], [5500, -1700], [5250, -1000]
    ],
    scenery: { lake: true, lakeShrink: 0.7, city: true, trees: 44, grandstands: 10 }
  },

   {
    id: 'monza',
    name: 'Monza',
    place: 'Italy',
    available: true,
    points: [
    [2500, -650], [1300, -650], [0, -650], [100, -1300], [-2000, -500], [-4000, -1000], 
    [-3750, -3000], [-4750, -3000], [-4000, -5500], [-2000, -5750], [-1750, -2250], 
    [-1000, -2500], [0, -2500], [5000, -2500], [5500, -1500], [5000, -750], [4000, -650]
    ],
    scenery: { lake: false, lakeShrink: 0.7, city: false, trees: 100, grandstands: 30 }
  },

   {
    id: 'redBullRing',
    name: 'Red Bull Ring',
    place: 'Austria',
    available: true,
    points: [
    [2500, -650], [1300, -650], [1300, -3000], [1300, -4000], [900, -5250],
    [4000, -4750], [4000, -4250], [2000, -4000], [2000, -2750], [2500, -3000], 
    [3000, -3000], [5500, -2750], [5750, -1000], [4000, -650]
    ],
    scenery: { lake: false, lakeShrink: 0.7, city: false, trees: 200, grandstands: 10 }
  },

  {
    id: 'testoval',
    name: 'Speedbowl',
    place: 'Test Track',
    available: true,
    points: [
      [0, 0], [1800, 0], [3000, 400], [3400, 1400], [3000, 2400],
      [1800, 2800], [0, 2800], [-1200, 2400], [-1600, 1400], [-1200, 400]
    ],
    width: 200,
    scenery: { lake: false, city: false, trees: 30, grandstands: 8 }
  }

];
