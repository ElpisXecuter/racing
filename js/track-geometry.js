/* ===========================================================================
   track-geometry.js — turns a list of coordinates into a drivable circuit
   ---------------------------------------------------------------------------
   Pure maths, no THREE.js. Given a track definition from tracks.js it produces
   a smooth centre line plus everything the rest of the game asks of a track:
   where the tarmac edge is, which way is "outside", where the start/finish
   line sits, and where each starting grid slot goes.

   You should not normally need to edit this file to add a track — add the
   coordinates to tracks.js instead.
   =========================================================================== */

GAME.TrackGeometry = (function () {
  'use strict';

  function dist(x1, y1, x2, y2) { return Math.hypot(x2 - x1, y2 - y1); }
  function normalize2(x, y) { var l = Math.hypot(x, y) || 1; return [x / l, y / l]; }

  // corner-cutting subdivision
  function chaikin(poly, iterations) {
    var cur = poly;
    for (var it = 0; it < iterations; it++) {
      var next = [];
      for (var i = 0; i < cur.length; i++) {
        var a = cur[i], b = cur[(i + 1) % cur.length];
        next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
        next.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
      }
      cur = next;
    }
    return cur;
  }

  // averaging passes — rounds any remaining tight apex into a continuous arc
  function relax(poly, passes, strength) {
    var cur = poly;
    for (var p = 0; p < passes; p++) {
      var next = [];
      for (var i = 0; i < cur.length; i++) {
        var a = cur[(i - 1 + cur.length) % cur.length];
        var b = cur[i];
        var c = cur[(i + 1) % cur.length];
        var tx = (a[0] + c[0]) / 2, tz = (a[1] + c[1]) / 2;
        next.push([b[0] + (tx - b[0]) * strength, b[1] + (tz - b[1]) * strength]);
      }
      cur = next;
    }
    return cur;
  }

  // even spacing so no segment is much shorter than its neighbours
  function resample(poly, count) {
    var total = 0, lens = [];
    for (var i = 0; i < poly.length; i++) {
      var a = poly[i], b = poly[(i + 1) % poly.length];
      var l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      lens.push(l); total += l;
    }
    var step = total / count, out = [], target = 0, acc = 0, idx = 0;
    while (out.length < count && idx < poly.length) {
      while (target <= acc + lens[idx] && out.length < count) {
        var t = (target - acc) / (lens[idx] || 1);
        var a2 = poly[idx], b2 = poly[(idx + 1) % poly.length];
        out.push([a2[0] + (b2[0] - a2[0]) * t, a2[1] + (b2[1] - a2[1]) * t]);
        target += step;
      }
      acc += lens[idx];
      idx++;
    }
    return out;
  }

  function closestOnSegment(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    var len2 = dx * dx + dy * dy;
    var t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    var cx = ax + t * dx, cy = ay + t * dy;
    return { x: cx, y: cy, t: t, d: dist(px, py, cx, cy) };
  }

  function segmentsIntersect(p1, p2, p3, p4) {
    function cross(ox, oy, ax, ay, bx, by) { return (ax - ox) * (by - oy) - (ay - oy) * (bx - ox); }
    var d1 = cross(p3.x, p3.y, p4.x, p4.y, p1.x, p1.y);
    var d2 = cross(p3.x, p3.y, p4.x, p4.y, p2.x, p2.y);
    var d3 = cross(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
    var d4 = cross(p1.x, p1.y, p2.x, p2.y, p4.x, p4.y);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
           ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  }

  var MITER_CLAMP = 1.6;
  var CELL = 260;

  function create(def) {
    var cfg = GAME.Config.track;
    var sm = def.smoothing || cfg.smoothing;

    var pts = resample(
      relax(chaikin(def.points, sm.chaikin), sm.relaxPasses, sm.relaxStrength),
      sm.samples
    );
    var N = pts.length;

    var TRACK_WIDTH = def.width || cfg.width;
    var HALF_WIDTH = TRACK_WIDTH / 2;
    var CURB_HW = HALF_WIDTH + (def.curbWidth || cfg.curbWidth);
    var RUNOFF_HW = CURB_HW + (def.runoffWidth || cfg.runoffWidth);
    var BARRIER_HW = RUNOFF_HW + cfg.barrierGap;

    function seg(i) {
      var a = pts[i], b = pts[(i + 1) % N];
      return { ax: a[0], ay: a[1], bx: b[0], by: b[1] };
    }
    function segNormal(i) { var s = seg(i); return normalize2(-(s.by - s.ay), s.bx - s.ax); }

    // ---- spatial hash so "where am I on the track?" stays cheap -------------
    var grid = {};
    function cellKey(cx, cz) { return cx + ',' + cz; }
    (function buildGrid() {
      for (var i = 0; i < N; i++) {
        var s = seg(i);
        var steps = Math.max(1, Math.ceil(dist(s.ax, s.ay, s.bx, s.by) / (CELL / 2)));
        for (var j = 0; j <= steps; j++) {
          var t = j / steps;
          var x = s.ax + (s.bx - s.ax) * t;
          var z = s.ay + (s.by - s.ay) * t;
          var cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
          for (var ox = -1; ox <= 1; ox++) {
            for (var oz = -1; oz <= 1; oz++) {
              var k = cellKey(cx + ox, cz + oz);
              if (!grid[k]) grid[k] = [];
              if (grid[k].indexOf(i) === -1) grid[k].push(i);
            }
          }
        }
      }
    })();

    function nearestTrackInfo(px, py) {
      var k = cellKey(Math.floor(px / CELL), Math.floor(py / CELL));
      var candidates = grid[k];
      var best = null, bestIdx = -1, i, s, c;
      if (candidates && candidates.length) {
        for (var ci = 0; ci < candidates.length; ci++) {
          i = candidates[ci];
          s = seg(i);
          c = closestOnSegment(px, py, s.ax, s.ay, s.bx, s.by);
          if (!best || c.d < best.d) { best = c; bestIdx = i; }
        }
        return { point: best, index: bestIdx };
      }
      for (i = 0; i < N; i++) {
        s = seg(i);
        c = closestOnSegment(px, py, s.ax, s.ay, s.bx, s.by);
        if (!best || c.d < best.d) { best = c; bestIdx = i; }
      }
      return { point: best, index: bestIdx };
    }

    function insideTrackLoop(px, py) {
      var inside = false;
      for (var i = 0, j = N - 1; i < N; j = i++) {
        var xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
        if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / ((yj - yi) || 1e-9) + xi)) {
          inside = !inside;
        }
      }
      return inside;
    }

    // ---- offsets with miter correction + fold-over repair -------------------
    var avgNormals = [], miterScale = [];
    (function computeNormals() {
      for (var i = 0; i < N; i++) {
        var nIn = segNormal((i - 1 + N) % N);
        var nOut = segNormal(i);
        var sx = nIn[0] + nOut[0], sy = nIn[1] + nOut[1];
        var avg = (Math.hypot(sx, sy) < 0.0001) ? nOut : normalize2(sx, sy);
        var cosHalf = avg[0] * nOut[0] + avg[1] * nOut[1];
        var scale = (Math.abs(cosHalf) < 0.0001) ? MITER_CLAMP : 1 / cosHalf;
        avgNormals.push(avg);
        miterScale.push(Math.max(-MITER_CLAMP, Math.min(MITER_CLAMP, scale)));
      }
    })();

    function offsetPoints(signedDist, repair) {
      var out = [];
      for (var i = 0; i < N; i++) {
        var m = miterScale[i];
        out.push([
          pts[i][0] + avgNormals[i][0] * signedDist * m,
          pts[i][1] + avgNormals[i][1] * signedDist * m
        ]);
      }
      if (!repair) return out;

      var target = Math.abs(signedDist);
      for (var r = 0; r < out.length; r++) {
        var p = out[r];
        var info = nearestTrackInfo(p[0], p[1]);
        if (info.point.d < target * 0.95) {
          var dx = p[0] - info.point.x, dy = p[1] - info.point.y;
          var len = Math.hypot(dx, dy);
          if (len < 0.001) {
            dx = avgNormals[r][0] * (signedDist < 0 ? -1 : 1);
            dy = avgNormals[r][1] * (signedDist < 0 ? -1 : 1);
            len = 1;
          }
          out[r] = [info.point.x + (dx / len) * target, info.point.y + (dy / len) * target];
        }
      }
      for (var pass = 0; pass < 3; pass++) {
        var smoothed = [];
        for (var q = 0; q < out.length; q++) {
          var a = out[(q - 1 + out.length) % out.length], b = out[q], c = out[(q + 1) % out.length];
          smoothed.push([
            a[0] * 0.25 + b[0] * 0.5 + c[0] * 0.25,
            a[1] * 0.25 + b[1] * 0.5 + c[1] * 0.25
          ]);
        }
        out = smoothed;
      }
      return out;
    }

    // ---- centres, orientation ----------------------------------------------
    var centroidX = 0, centroidZ = 0;
    for (var ci2 = 0; ci2 < N; ci2++) { centroidX += pts[ci2][0]; centroidZ += pts[ci2][1]; }
    centroidX /= N; centroidZ /= N;

    var outSign = insideTrackLoop(
      pts[0][0] + avgNormals[0][0] * 400,
      pts[0][1] + avgNormals[0][1] * 400
    ) ? -1 : 1;

    var minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    pts.forEach(function (p) {
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
      minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]);
    });

    // ---- start / finish -----------------------------------------------------
    var s0 = seg(0);
    var s0len = Math.hypot(s0.bx - s0.ax, s0.by - s0.ay);
    var s0ux = (s0.bx - s0.ax) / s0len, s0uy = (s0.by - s0.ay) / s0len;
    var perpx = -s0uy, perpy = s0ux;

    var finish = {
      x1: s0.ax + perpx * HALF_WIDTH, y1: s0.ay + perpy * HALF_WIDTH,
      x2: s0.ax - perpx * HALF_WIDTH, y2: s0.ay - perpy * HALF_WIDTH,
      ux: s0ux, uy: s0uy
    };
    var startHeading = Math.atan2(s0uy, s0ux);

    // Staggered two-by-two starting grid behind the line, alternating sides.
    // Index 0 is pole. Solo play uses slot 0 too, just centred.
    function gridSlot(index) {
      var row = Math.floor(index / 2);
      var side = (index % 2 === 0) ? -1 : 1;
      var back = 70 + row * 38;
      var lateral = side * (HALF_WIDTH * 0.42);
      return {
        x: s0.ax - s0ux * back + perpx * lateral,
        y: s0.ay - s0uy * back + perpy * lateral,
        angle: startHeading
      };
    }
    function soloStart() {
      return { x: s0.ax - s0ux * 90, y: s0.ay - s0uy * 90, angle: startHeading };
    }

    return {
      def: def,
      pts: pts, N: N,
      TRACK_WIDTH: TRACK_WIDTH, HALF_WIDTH: HALF_WIDTH,
      CURB_HW: CURB_HW, RUNOFF_HW: RUNOFF_HW, BARRIER_HW: BARRIER_HW,
      CAR_RADIUS: cfg.carRadius,
      centroid: { x: centroidX, z: centroidZ },
      center: { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 },
      outSign: outSign,
      avgNormals: avgNormals,
      halfwayIdx: Math.floor(N / 2),
      finish: finish,
      startHeading: startHeading,
      seg: seg,
      nearestTrackInfo: nearestTrackInfo,
      insideTrackLoop: insideTrackLoop,
      offsetPoints: offsetPoints,
      gridSlot: gridSlot,
      soloStart: soloStart
    };
  }

  return {
    create: create,
    dist: dist,
    normalize2: normalize2,
    segmentsIntersect: segmentsIntersect
  };
})();
