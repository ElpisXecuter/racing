/* ===========================================================================
   car-model.js — the 3D shape of the car
   ---------------------------------------------------------------------------
   One factory function builds a fresh car in any livery. It is used for the
   car you drive, every remote car in multiplayer, and the small spinning
   previews in the livery menu — so a change here shows up everywhere.

   Coordinates are local to the car: +X is forward, +Y is up, +Z is to the
   right. The car is roughly 62 units long and 26 wide.

   Colours come from liveries.js, not from here.
   =========================================================================== */

GAME.CarModel = (function () {
  'use strict';

  // Shared look of parts that are the same on every car regardless of livery.
  var SHARED = {
    dark: 0x14161c,
    wing: 0x101114,
    tyre: 0x15161a,
    rim: 0x8a8f96,
    visor: 0x0c0f14,
    brakeOff: 0x3a0a0a,
    brakeOn: 0xff1f1f
  };

  function create(liveryColors) {
    var group = new THREE.Group();
    var wheelMeshes = [], frontWheelGroups = [], brakeLights = [];

    var bodyMat = new THREE.MeshLambertMaterial({ color: liveryColors.primary, flatShading: true });
    var accentMat = new THREE.MeshLambertMaterial({ color: liveryColors.accent, flatShading: true });
    var trimMat = new THREE.MeshLambertMaterial({ color: liveryColors.trim, flatShading: true });
    var darkMat = new THREE.MeshLambertMaterial({ color: SHARED.dark, flatShading: true });
    var wingMat = new THREE.MeshLambertMaterial({ color: SHARED.wing, flatShading: true });
    var wheelMat = new THREE.MeshLambertMaterial({ color: SHARED.tyre, flatShading: true });
    var rimMat = new THREE.MeshLambertMaterial({ color: SHARED.rim, flatShading: true });
    var visorMat = new THREE.MeshBasicMaterial({ color: SHARED.visor });

    // survival cell (narrow, central)
    var tub = new THREE.Mesh(new THREE.BoxGeometry(15, 3, 5.2), bodyMat);
    tub.position.set(0, 4.4, 0);
    group.add(tub);

    // long tapering nose
    var nose = new THREE.Mesh(new THREE.ConeGeometry(5, 24, 8), bodyMat);
    nose.rotation.z = -Math.PI / 2;
    nose.position.set(20, 5, 0);
    group.add(nose);
    var noseTip = new THREE.Mesh(new THREE.ConeGeometry(0.7, 4, 8), accentMat);
    noseTip.rotation.z = -Math.PI / 2;
    noseTip.position.set(31.5, 5, 0);
    group.add(noseTip);
    var noseStripe = new THREE.Mesh(new THREE.BoxGeometry(17, 0.55, 0.9), trimMat);
    noseStripe.position.set(18, 5.8, 0);
    noseStripe.rotation.z = 0.1;
    group.add(noseStripe);

    // sidepods extended out toward the front wheels, plus bargeboards and a
    // floor edge strake — this is what closes the gap between body and tyre
    [-1, 1].forEach(function (s) {
      var podFront = new THREE.Mesh(new THREE.BoxGeometry(9, 3.4, 6.4), bodyMat);
      podFront.position.set(2, 4.1, s * 5.6);
      group.add(podFront);
      var podRear = new THREE.Mesh(new THREE.BoxGeometry(7, 2.6, 4.6), bodyMat);
      podRear.position.set(-8, 3.8, s * 4.6);
      group.add(podRear);
      var stripe = new THREE.Mesh(new THREE.BoxGeometry(12, 1.4, 0.4), accentMat);
      stripe.position.set(1, 5.1, s * 8.5);
      stripe.rotation.z = -0.15;
      group.add(stripe);

      var bargeboard = new THREE.Mesh(new THREE.BoxGeometry(4.5, 3.2, 0.5), darkMat);
      bargeboard.position.set(5.5, 3.4, s * 9.6);
      bargeboard.rotation.y = s * 0.35;
      group.add(bargeboard);
      var bargeboard2 = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.2, 0.4), darkMat);
      bargeboard2.position.set(2.5, 3, s * 8.4);
      bargeboard2.rotation.y = s * 0.5;
      group.add(bargeboard2);

      var floorEdge = new THREE.Mesh(new THREE.BoxGeometry(19, 0.5, 1), darkMat);
      floorEdge.position.set(-3, 1.3, s * 9.9);
      group.add(floorEdge);
    });

    // engine cover, tapering back
    var hump = new THREE.Mesh(new THREE.BoxGeometry(10, 3.6, 3.6), bodyMat);
    hump.position.set(-13, 5, 0);
    group.add(hump);
    var tailCone = new THREE.Mesh(new THREE.ConeGeometry(1.7, 10, 8), bodyMat);
    tailCone.rotation.z = Math.PI / 2;
    tailCone.position.set(-23, 5, 0);
    group.add(tailCone);
    var airbox = new THREE.Mesh(new THREE.BoxGeometry(3, 2.8, 2.2), darkMat);
    airbox.position.set(-8, 8, 0);
    group.add(airbox);

    var cockpit = new THREE.Mesh(new THREE.BoxGeometry(5, 1.5, 3.2), visorMat);
    cockpit.position.set(5, 6.7, 0);
    group.add(cockpit);

    // mirrors on thin stalks
    [-1, 1].forEach(function (s) {
      var stalk = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.4, 0.4), darkMat);
      stalk.position.set(8, 7.8, s * 5.8);
      group.add(stalk);
      var mirror = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.2, 1.6), darkMat);
      mirror.position.set(9.5, 7.9, s * 6.6);
      group.add(mirror);
    });

    // halo
    var halo = new THREE.Mesh(new THREE.TorusGeometry(3.4, 0.4, 6, 18), darkMat);
    halo.rotation.x = Math.PI / 2;
    halo.position.set(3.6, 7.9, 0);
    group.add(halo);
    var haloPost = new THREE.Mesh(new THREE.BoxGeometry(0.8, 2.2, 0.8), darkMat);
    haloPost.position.set(7, 6.9, 0);
    group.add(haloPost);
    var haloAccent = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 0.9), accentMat);
    haloAccent.position.set(7, 8.1, 0);
    group.add(haloAccent);

    // three-element front wing with endplates and turning vanes
    var fw1 = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.6, 27), wingMat);
    fw1.position.set(31, 1.5, 0);
    group.add(fw1);
    var fw2 = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.5, 23), wingMat);
    fw2.position.set(29.6, 2.1, 0);
    group.add(fw2);
    var fw3 = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.45, 19), wingMat);
    fw3.position.set(28.4, 2.7, 0);
    group.add(fw3);
    [-1, 1].forEach(function (s) {
      var endplate = new THREE.Mesh(new THREE.BoxGeometry(5.5, 3.6, 0.5), trimMat);
      endplate.position.set(30, 2, s * 13.3);
      group.add(endplate);
      var vane = new THREE.Mesh(new THREE.BoxGeometry(3, 1.6, 0.4), darkMat);
      vane.position.set(26, 2.4, s * 11.5);
      vane.rotation.y = s * 0.4;
      group.add(vane);
    });

    // rear wing, endplates, beam wing and a simple diffuser
    var rearWing = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.8, 19), wingMat);
    rearWing.position.set(-27, 10.4, 0);
    group.add(rearWing);
    var rearWingLower = new THREE.Mesh(new THREE.BoxGeometry(2, 0.6, 16), wingMat);
    rearWingLower.position.set(-26.2, 9, 0);
    group.add(rearWingLower);
    [-1, 1].forEach(function (s) {
      var pillar = new THREE.Mesh(new THREE.BoxGeometry(1.5, 6, 1), darkMat);
      pillar.position.set(-27, 7.4, s * 7.4);
      group.add(pillar);
      var endplate = new THREE.Mesh(new THREE.BoxGeometry(3.4, 5.4, 0.5), trimMat);
      endplate.position.set(-27, 10, s * 9.2);
      group.add(endplate);
    });
    var beamWing = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.6, 12), wingMat);
    beamWing.position.set(-24.5, 6.6, 0);
    group.add(beamWing);
    var diffuser = new THREE.Mesh(new THREE.BoxGeometry(7, 1.6, 15), darkMat);
    diffuser.position.set(-21, 2.4, 0);
    diffuser.rotation.z = 0.12;
    group.add(diffuser);

    // brake lights: unlit material so they read clearly as off/on
    var brakeOffMat = new THREE.MeshBasicMaterial({ color: SHARED.brakeOff });
    [-1, 1].forEach(function (s) {
      var lightMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 2.6), brakeOffMat.clone());
      lightMesh.position.set(-24.3, 5.6, s * 4.2);
      group.add(lightMesh);
      brakeLights.push(lightMesh);
    });

    // wheels
    var wheelGeo = new THREE.CylinderGeometry(4.7, 4.7, 4, 16);
    var rimGeo = new THREE.CylinderGeometry(2, 2, 4.2, 12);
    [[16, -11, true], [16, 11, true], [-16, -10.4, false], [-16, 10.4, false]].forEach(function (p) {
      var pivot = new THREE.Group();
      pivot.position.set(p[0], 4.7, p[1]);
      var wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.rotation.x = Math.PI / 2;
      pivot.add(wheel);
      var rim = new THREE.Mesh(rimGeo, rimMat);
      rim.rotation.x = Math.PI / 2;
      pivot.add(rim);
      group.add(pivot);
      wheelMeshes.push(wheel);
      if (p[2]) frontWheelGroups.push(pivot);
    });

    return {
      group: group,
      wheelMeshes: wheelMeshes,
      frontWheelGroups: frontWheelGroups,
      brakeLights: brakeLights
    };
  }

  return {
    create: create,
    BRAKE_ON: new THREE.Color(SHARED.brakeOn),
    BRAKE_OFF: new THREE.Color(SHARED.brakeOff)
  };
})();
