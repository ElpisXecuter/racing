/* ===========================================================================
   track-scene.js — builds the visible circuit (tarmac, kerbs, barriers, fence)
   ---------------------------------------------------------------------------
   Takes the geometry produced by track-geometry.js and returns one THREE.Group
   containing every piece of the circuit itself. Scenery around the circuit
   lives in scenery.js.

   Colours and widths come from config.js, so edit them there rather than here.
   =========================================================================== */

GAME.TrackScene = (function () {
  'use strict';

  var dist = GAME.TrackGeometry.dist;

  // ---- reusable ribbon / wall builders -------------------------------------
  function quadRibbon(N, arrA, arrB, y, color) {
    var verts = [], idx = [];
    for (var i = 0; i < N; i++) {
      var a0 = arrA[i], b0 = arrB[i], a1 = arrA[(i + 1) % N], b1 = arrB[(i + 1) % N];
      var base = verts.length / 3;
      verts.push(a0[0], y, a0[1]);
      verts.push(b0[0], y, b0[1]);
      verts.push(b1[0], y, b1[1]);
      verts.push(a1[0], y, a1[1]);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setIndex(idx);
    return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: color, side: THREE.DoubleSide }));
  }

  function quadRibbonStriped(pts, N, arrA, arrB, y, colorA, colorB, stripeLen) {
    var verts = [], colors = [], idx = [];
    var cA = new THREE.Color(colorA), cB = new THREE.Color(colorB);
    var travelled = 0;
    for (var i = 0; i < N; i++) {
      var a0 = arrA[i], b0 = arrB[i], a1 = arrA[(i + 1) % N], b1 = arrB[(i + 1) % N];
      var base = verts.length / 3;
      verts.push(a0[0], y, a0[1]);
      verts.push(b0[0], y, b0[1]);
      verts.push(b1[0], y, b1[1]);
      verts.push(a1[0], y, a1[1]);
      var c = (Math.floor(travelled / stripeLen) % 2 === 0) ? cA : cB;
      for (var k = 0; k < 4; k++) colors.push(c.r, c.g, c.b);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      travelled += dist(pts[i][0], pts[i][1], pts[(i + 1) % N][0], pts[(i + 1) % N][1]);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(idx);
    return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  }

  function wallStriped(N, arr, y0, y1, colorA, colorB, stripeLen) {
    var verts = [], colors = [], idx = [];
    var cA = new THREE.Color(colorA), cB = new THREE.Color(colorB);
    var travelled = 0;
    for (var i = 0; i < N; i++) {
      var p0 = arr[i], p1 = arr[(i + 1) % N];
      var base = verts.length / 3;
      verts.push(p0[0], y0, p0[1]);
      verts.push(p1[0], y0, p1[1]);
      verts.push(p1[0], y1, p1[1]);
      verts.push(p0[0], y1, p0[1]);
      var c = (Math.floor(travelled / stripeLen) % 2 === 0) ? cA : cB;
      for (var k = 0; k < 4; k++) colors.push(c.r, c.g, c.b);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      travelled += dist(p0[0], p0[1], p1[0], p1[1]);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(idx);
    return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  }

  function wallPlain(N, arr, y0, y1, mat) {
    var verts = [], idx = [];
    for (var i = 0; i < N; i++) {
      var p0 = arr[i], p1 = arr[(i + 1) % N];
      var base = verts.length / 3;
      verts.push(p0[0], y0, p0[1]);
      verts.push(p1[0], y0, p1[1]);
      verts.push(p1[0], y1, p1[1]);
      verts.push(p0[0], y1, p0[1]);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setIndex(idx);
    return new THREE.Mesh(geo, mat);
  }

  // ---- catch fencing: one panel + one top rail per side ---------------------
  function buildFencing(group, T, barrierTop, fenceTop) {
    var C = GAME.Config.trackColors;
    var meshMat = new THREE.MeshBasicMaterial({
      color: C.fenceMesh, transparent: true, opacity: 0.18,
      side: THREE.DoubleSide, depthWrite: false
    });
    var railMat = new THREE.MeshLambertMaterial({ color: C.fenceRail, flatShading: true });

    [T.leftBarrier, T.rightBarrier].forEach(function (line) {
      group.add(wallPlain(T.N, line, barrierTop, fenceTop - 1.5, meshMat));
      group.add(wallPlain(T.N, line, fenceTop - 1.5, fenceTop, railMat));

      var placements = [];
      var travelled = 0, nextAt = 0, spacing = 95;
      for (var i = 0; i < T.N; i++) {
        var p0 = line[i], p1 = line[(i + 1) % T.N];
        var len = dist(p0[0], p0[1], p1[0], p1[1]);
        while (nextAt < travelled + len) {
          var t = (nextAt - travelled) / (len || 1);
          placements.push([p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t]);
          nextAt += spacing;
        }
        travelled += len;
      }
      var posts = new THREE.InstancedMesh(
        new THREE.BoxGeometry(2, fenceTop - barrierTop, 2),
        railMat,
        placements.length
      );
      var m = new THREE.Matrix4();
      placements.forEach(function (p, i) {
        m.makeTranslation(p[0], (barrierTop + fenceTop) / 2, p[1]);
        posts.setMatrixAt(i, m);
      });
      group.add(posts);
    });
  }

  // ---- dashed centre line ---------------------------------------------------
  function buildDashes(group, T) {
    var placements = [];
    var travelled = 0, nextAt = 0, spacing = 90;
    for (var i = 0; i < T.N; i++) {
      var s = T.seg(i);
      var len = dist(s.ax, s.ay, s.bx, s.by);
      var ang = Math.atan2(s.by - s.ay, s.bx - s.ax);
      while (nextAt < travelled + len) {
        var t = (nextAt - travelled) / (len || 1);
        placements.push([s.ax + (s.bx - s.ax) * t, s.ay + (s.by - s.ay) * t, ang]);
        nextAt += spacing;
      }
      travelled += len;
    }
    var mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(16, 0.4, 4),
      new THREE.MeshBasicMaterial({ color: GAME.Config.trackColors.edgeLine }),
      placements.length
    );
    var m = new THREE.Matrix4();
    placements.forEach(function (p, i) {
      m.makeRotationY(-p[2]);
      m.setPosition(p[0], 1.5, p[1]);
      mesh.setMatrixAt(i, m);
    });
    group.add(mesh);
  }

  // ---- chequered start/finish line -----------------------------------------
  function buildFinishLine(group, T) {
    var f = T.finish;
    var verts = [], colors = [], idx = [];
    var steps = 12, thick = 18;
    var fx = f.x2 - f.x1, fy = f.y2 - f.y1;
    var flen = Math.hypot(fx, fy);
    var fux = fx / flen, fuy = fy / flen;
    var cW = new THREE.Color(0xffffff), cB = new THREE.Color(0x111111);
    for (var i = 0; i < steps; i++) {
      var t0 = i / steps, t1 = (i + 1) / steps;
      var ax = f.x1 + fux * flen * t0, ay = f.y1 + fuy * flen * t0;
      var bx = f.x1 + fux * flen * t1, by = f.y1 + fuy * flen * t1;
      var base = verts.length / 3;
      verts.push(ax - f.ux * thick / 2, 1.6, ay - f.uy * thick / 2);
      verts.push(bx - f.ux * thick / 2, 1.6, by - f.uy * thick / 2);
      verts.push(bx + f.ux * thick / 2, 1.6, by + f.uy * thick / 2);
      verts.push(ax + f.ux * thick / 2, 1.6, ay + f.uy * thick / 2);
      var c = (i % 2 === 0) ? cW : cB;
      for (var k = 0; k < 4; k++) colors.push(c.r, c.g, c.b);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(idx);
    group.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })));
  }

  // ---- main entry point -----------------------------------------------------
  function build(T) {
    var C = GAME.Config.trackColors;
    var cfg = GAME.Config.track;
    var group = new THREE.Group();
    var N = T.N, HW = T.HALF_WIDTH;

    // barriers are cached on the geometry so scenery can reuse them
    T.leftBarrier = T.offsetPoints(T.BARRIER_HW, true);
    T.rightBarrier = T.offsetPoints(-T.BARRIER_HW, true);

    group.add(quadRibbon(N, T.offsetPoints(T.RUNOFF_HW, true), T.offsetPoints(T.CURB_HW), 0.2, C.runoff));
    group.add(quadRibbon(N, T.offsetPoints(-T.CURB_HW), T.offsetPoints(-T.RUNOFF_HW, true), 0.2, C.runoff));
    group.add(quadRibbonStriped(T.pts, N, T.offsetPoints(T.CURB_HW), T.offsetPoints(-T.CURB_HW), 0.5, C.kerbA, C.kerbB, C.kerbStripeLen));
    group.add(quadRibbon(N, T.offsetPoints(HW), T.offsetPoints(-HW), 1.0, C.tarmac));
    group.add(quadRibbon(N, T.offsetPoints(HW - 2), T.offsetPoints(HW - 7), 1.2, C.edgeLine));
    group.add(quadRibbon(N, T.offsetPoints(-(HW - 2)), T.offsetPoints(-(HW - 7)), 1.2, C.edgeLine));

    group.add(wallStriped(N, T.leftBarrier, 0, cfg.barrierHeight, C.barrierA, C.barrierB, C.barrierStripeLen));
    group.add(wallStriped(N, T.rightBarrier, 0, cfg.barrierHeight, C.barrierA, C.barrierB, C.barrierStripeLen));

    buildFencing(group, T, cfg.barrierHeight, cfg.fenceHeight);
    buildDashes(group, T);
    buildFinishLine(group, T);

    return group;
  }

  return { build: build, quadRibbon: quadRibbon, wallPlain: wallPlain };
})();
