/* ===========================================================================
   liveries.js — the paint schemes
   ---------------------------------------------------------------------------
   TO ADD A LIVERY: copy a block and change the three colours.
     primary  main bodywork (tub, nose, sidepods, engine cover)
     accent   nose tip, sidepod stripe, halo flash
     trim     nose stripe and wing endplates
   Set available:false to show it greyed out in the menu.
   =========================================================================== */

GAME.Liveries = [
  { id: 'redbull',     name: 'Red Bull Racing', available: true, colors: { primary: 0x0a1e46, accent: 0xe4002b, trim: 0xf6c500 } },
  { id: 'mclaren',     name: 'McLaren',         available: true, colors: { primary: 0xff8000, accent: 0x14161c, trim: 0x2fc7d6 } },
  { id: 'alpine',      name: 'Alpine',          available: true, colors: { primary: 0xff5fae, accent: 0x16233f, trim: 0xf2f2f2 } },
  { id: 'astonmartin', name: 'Aston Martin',    available: true, colors: { primary: 0x0b3d30, accent: 0x0d0d0d, trim: 0xc6ff3d } },
  { id: 'audi',        name: 'Audi',            available: true, colors: { primary: 0xc9ccd1, accent: 0xe10600, trim: 0x1a1a1a } },
  { id: 'cadillac',    name: 'Cadillac',        available: true, colors: { primary: 0xd9dbdd, accent: 0x141414, trim: 0xa61c22 } },
  { id: 'ferrari',     name: 'Ferrari',         available: true, colors: { primary: 0xd2001f, accent: 0x111111, trim: 0xffffff } },
  { id: 'haas',        name: 'Haas',            available: true, colors: { primary: 0xf2f2f2, accent: 0xd2001c, trim: 0x161616 } },
  { id: 'mercedes',    name: 'Mercedes',        available: true, colors: { primary: 0x111214, accent: 0x00d7b6, trim: 0xc0c0c0 } },
  { id: 'racingbulls', name: 'Racing Bulls',    available: true, colors: { primary: 0xf0f0f0, accent: 0x1e2a5e, trim: 0xdb0a2c } },
  { id: 'williams',    name: 'Williams',        available: true, colors: { primary: 0x1547d6, accent: 0x0a1220, trim: 0x8fd4ff } }
];
