/* ===========================================================================
   scenery.js — everything around the circuit
   ---------------------------------------------------------------------------
   Grandstands, trees, the infield lake and the distant city skyline. All of it
   is placed automatically relative to whatever track is loaded, so a new track
   in tracks.js gets scenery without any extra work.

   Per-track switches live in tracks.js under `scenery`:
     lake: true/false, lakeShrink: 0-1, city: true/false,
     trees: <count>, grandstands: <count>
   =========================================================================== */

GAME.Scenery = (function () {
  'use strict';

  var dist = GAME.TrackGeometry.dist;
  var normalize2 = GAME.TrackGeometry.normalize2;

  var CROWD_COLORS = [0xe63946, 0x1d3557, 0xf1c453, 0x2a9d8f, 0xf4a261, 0xffffff, 0x6d597a, 0x333333];
  var STAND_W = 170, STAND_DEPTH = 60;
  var STAND_FOOTPRINT = Math.hypot(STAND_W, STAND_DEPTH) / 2 + 12;

  function buildGrandstand() {
    var g = new THREE.Group();
    var tierCount = 6, tierH = 8, tierD = 9;
    var structMat = new THREE.MeshLambertMaterial({ color: 0x50565f, flatShading: true });
    var structMat2 = new THREE.MeshLambertMaterial({ color: 0x40454d, flatShading: true });
    for (var t = 0; t < tierCount; t++) {
      var tier = new THREE.Mesh(new THREE.BoxGeometry(STAND_W, tierH, tierD), (t % 2 === 0) ? structMat : structMat2);
      tier.position.set(0, tierH / 2 + t * tierH, -t * tierD);
      g.add(tier);
      var seatCount = 28;
      for (var s = 0; s < seatCount; s++) {
        var px = -STAND_W / 2 + 4 + s * ((STAND_W - 8) / (seatCount - 1));
        if (Math.random() < 0.12) continue;
        var person = new THREE.Mesh(
          new THREE.BoxGeometry(2.6, 4 + Math.random() * 1.5, 2.2),
          new THREE.MeshLambertMaterial({ color: CROWD_COLORS[(t * 7 + s * 3) % CROWD_COLORS.length], flatShading: true })
        );
        person.position.set(px, tierH + 2.2, -t * tierD);
        g.add(person);
      }
    }
    var roof = new THREE.Mesh(
      new THREE.BoxGeometry(STAND_W + 6, 1.5, tierCount * tierD * 0.55),
      new THREE.MeshLambertMaterial({ color: 0x2b2f36, flatShading: true })
    );
    roof.position.set(0, tierCount * tierH + 6, -tierCount * tierD * 0.55);
    roof.rotation.x = 0.28;
    g.add(roof);
    return g;
  }

  function build(T) {
    var group = new THREE.Group();
    var opts = T.def.scenery || {};
    var N = T.N;

    // occupancy registry: nothing gets placed on top of anything else
    var occupied = [];
    function spotFree(x, z, radius) {
      for (var i = 0; i < occupied.length; i++) {
        var o = occupied[i];
        if (dist(x, z, o.x, o.z) < radius + o.r) return false;
      }
      return true;
    }
    function occupy(x, z, radius) { occupied.push({ x: x, z: z, r: radius }); }

    // walk outward until the spot clears the track, sits outside the circuit
    // loop, and doesn't overlap anything already placed
    function findClearSpot(idx, startDist, trackClearance, footprint) {
      var n = T.avgNormals[idx];
      var ox = n[0] * T.outSign, oz = n[1] * T.outSign;
      var d = startDist, x, z, tries = 0;
      while (tries < 70) {
        x = T.pts[idx][0] + ox * d;
        z = T.pts[idx][1] + oz * d;
        if (T.nearestTrackInfo(x, z).point.d >= trackClearance &&
            !T.insideTrackLoop(x, z) &&
            spotFree(x, z, footprint)) {
          return { x: x, z: z, ox: ox, oz: oz, ok: true };
        }
        d += 30;
        tries++;
      }
      return { ok: false };
    }

    // ---- infield lake -------------------------------------------------------
    if (opts.lake) {
      var SHRINK = opts.lakeShrink || 0.7;
      var cx = T.centroid.x, cz = T.centroid.z;
      var shorePts = [];
      for (var i = 0; i < N; i++) {
        var ang = (i / N) * Math.PI * 2;
        var jitter = 0.95 + 0.05 * Math.sin(ang * 3.1 + 1.2) + 0.03 * Math.sin(ang * 6.7);
        var k = SHRINK * jitter;
        shorePts.push([cx + (T.pts[i][0] - cx) * k, cz + (T.pts[i][1] - cz) * k]);
      }
      var verts = [cx, 0.12, cz], idx = [];
      shorePts.forEach(function (p) { verts.push(p[0], 0.12, p[1]); });
      for (var i2 = 0; i2 < N; i2++) idx.push(0, 1 + i2, 1 + ((i2 + 1) % N));
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      group.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x2f6f96, flatShading: true, side: THREE.DoubleSide })));

      var rimVerts = [], rimIdx = [];
      var rimShore = shorePts.map(function (p) {
        return [cx + (p[0] - cx) * 0.9, cz + (p[1] - cz) * 0.9];
      });
      for (var i3 = 0; i3 < N; i3++) {
        var o0 = shorePts[i3], o1 = shorePts[(i3 + 1) % N];
        var r0 = rimShore[i3], r1 = rimShore[(i3 + 1) % N];
        var base = rimVerts.length / 3;
        rimVerts.push(o0[0], 0.14, o0[1], o1[0], 0.14, o1[1], r1[0], 0.14, r1[1], r0[0], 0.14, r0[1]);
        rimIdx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
      var rimGeo = new THREE.BufferGeometry();
      rimGeo.setAttribute('position', new THREE.Float32BufferAttribute(rimVerts, 3));
      rimGeo.setIndex(rimIdx);
      group.add(new THREE.Mesh(rimGeo, new THREE.MeshBasicMaterial({ color: 0x5aa4c9, side: THREE.DoubleSide })));
    }

    // ---- grandstands --------------------------------------------------------
    var standCount = (opts.grandstands === undefined) ? 10 : opts.grandstands;
    for (var gi = 0; gi < standCount; gi++) {
      var sIdx = Math.round(gi * N / standCount) % N;
      var spot = findClearSpot(sIdx, T.BARRIER_HW + 70, T.BARRIER_HW + 60, STAND_FOOTPRINT);
      if (!spot.ok) continue;
      var stand = buildGrandstand();
      stand.position.set(spot.x, 0, spot.z);
      stand.rotation.y = Math.atan2(-spot.ox, -spot.oz);
      group.add(stand);
      occupy(spot.x, spot.z, STAND_FOOTPRINT);
    }

    // ---- trees --------------------------------------------------------------
    var treeCount = (opts.trees === undefined) ? 44 : opts.trees;
    if (treeCount > 0) {
      var trunkGeo = new THREE.BoxGeometry(4, 14, 4);
      var trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b4630 });
      var leafGeo = new THREE.ConeGeometry(13, 26, 6);
      var leafMat = new THREE.MeshLambertMaterial({ color: 0x2f7a3d });
      for (var ti = 0; ti < treeCount; ti++) {
        var tIdx = Math.round((ti + 0.5) * N / treeCount) % N;
        var tSpot = findClearSpot(tIdx, T.BARRIER_HW + 150 + (ti % 3) * 50, T.BARRIER_HW + 140, 22);
        if (!tSpot.ok) continue;
        var trunk = new THREE.Mesh(trunkGeo, trunkMat);
        trunk.position.set(tSpot.x, 7, tSpot.z);
        group.add(trunk);
        var leaf = new THREE.Mesh(leafGeo, leafMat);
        leaf.position.set(tSpot.x, 27, tSpot.z);
        group.add(leaf);
        occupy(tSpot.x, tSpot.z, 22);
      }
    }

    // ---- distant city -------------------------------------------------------
    if (opts.city) {
      var far = T.pts[Math.round(N * 0.45)];
      var ccx = T.centroid.x, ccz = T.centroid.z;
      var cbdDir = normalize2(far[0] - ccx, far[1] - ccz);
      var cbdAngle = Math.atan2(cbdDir[1], cbdDir[0]);
      var palette = [0x3d4a5c, 0x4a5568, 0x2d3748, 0x5c6b7f, 0x374357, 0x687b8f];
      var glassPalette = [0x6fa8c9, 0x89b8d6, 0x4f7fa0];
      var CITY_RADIUS = 4500, steps = 80;
      for (var ci = 0; ci < steps; ci++) {
        var cang = (ci / steps) * Math.PI * 2;
        var diff = Math.atan2(Math.sin(cang - cbdAngle), Math.cos(cang - cbdAngle));
        var weight = Math.max(0, 1 - Math.abs(diff) / (Math.PI * 0.55));
        if (Math.random() > (0.28 + weight * 0.72)) continue;
        var radius = CITY_RADIUS + (Math.random() - 0.5) * 700 - weight * 300;
        var bx = ccx + Math.cos(cang) * radius;
        var bz = ccz + Math.sin(cang) * radius;
        var w = 55 + Math.random() * 70, d2 = 55 + Math.random() * 70;
        var footprint = Math.hypot(w, d2) / 2 + 10;
        if (T.nearestTrackInfo(bx, bz).point.d < T.BARRIER_HW + 320) continue;
        if (T.insideTrackLoop(bx, bz)) continue;
        if (!spotFree(bx, bz, footprint)) continue;
        var h = 50 + weight * 260 * (0.5 + Math.random() * 0.9) + Math.random() * 60;
        var mat = new THREE.MeshLambertMaterial({
          color: Math.random() < 0.3 ? glassPalette[(Math.random() * glassPalette.length) | 0] : palette[(Math.random() * palette.length) | 0],
          flatShading: true
        });
        var building = new THREE.Mesh(new THREE.BoxGeometry(w, h, d2), mat);
        building.position.set(bx, h / 2, bz);
        building.rotation.y = Math.random() * Math.PI;
        group.add(building);
        occupy(bx, bz, footprint);
        if (h > 180 && Math.random() < 0.6) {
          var cap = new THREE.Mesh(
            new THREE.BoxGeometry(w * 0.3, h * 0.08, d2 * 0.3),
            new THREE.MeshLambertMaterial({ color: 0x1c2330, flatShading: true })
          );
          cap.position.set(bx, h + (h * 0.08) / 2, bz);
          group.add(cap);
        }
      }
    }

    return group;
  }

  return { build: build };
})();
