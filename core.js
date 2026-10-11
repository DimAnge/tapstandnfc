// Panel geometry. No DOM here: this file runs in the browser and in Node.
import Module from './vendor/manifold.js';

export const P = {
  W: 168, H: 100, R: 14,            // face above the tab (mm) and its corner radius
  TAB_W: 124, TAB_H: 6, TAB_R: 1,   // tab that sits in the base slot
  BODY: 4.0, CHAMFER: 0.6, STEP: 0.2,
  RELIEF: 1.2, SINK: 0.2,           // relief above BODY; SINK overlaps it into the body so the union is clean
  MARGIN: 6, MIN_FEATURE: 0.6,       // 0.6: details of about 0.74 mm are known to print with a 0.4 mm nozzle
  // Smallest too-thin area (mm2) worth a warning. Every sharp corner narrows to nothing at its tip and
  // just prints rounded: letter corners lose at most 0.12 mm2 and a 36 degree star point 0.165 mm2.
  // 0.2 is passed by tips sharper than about 32 degrees, which stay under MIN_FEATURE for over 1 mm.
  THIN_AREA: 0.2,
};
const SEG = 32;                     // segments per full circle for offsets
// Most outline points a traced logo may have once it is simplified and its specks are dropped.
// Build time grows with this number; see the timing note in test.mjs.
export const MAX_POINTS = 12000;

export async function init() { const wasm = await Module(); wasm.setup(); return wasm; }

function arc(cx, cy, r, a0) {       // quarter arc, counter-clockwise from angle a0
  const pts = [];
  for (let i = 0; i <= SEG; i++) { const a = a0 + (Math.PI / 2) * (i / SEG); pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return pts;
}
// Counter-clockwise rounded rectangle; r = [bottomLeft, bottomRight, topRight, topLeft]
export function rrect(x0, y0, x1, y1, [bl, br, tr, tl]) {
  return [
    ...(bl ? arc(x0 + bl, y0 + bl, bl, Math.PI) : [[x0, y0]]),
    ...(br ? arc(x1 - br, y0 + br, br, -Math.PI / 2) : [[x1, y0]]),
    ...(tr ? arc(x1 - tr, y1 - tr, tr, 0) : [[x1, y1]]),
    ...(tl ? arc(x0 + tl, y1 - tl, tl, Math.PI / 2) : [[x0, y1]]),
  ];
}

export function outline2d(wasm, p = P) {
  const { CrossSection } = wasm;
  const face = new CrossSection([rrect(-p.W / 2, 0, p.W / 2, p.H, [p.R, p.R, p.R, p.R])], 'EvenOdd');
  const tab = new CrossSection([rrect(-p.TAB_W / 2, -p.TAB_H, p.TAB_W / 2, 1, [p.TAB_R, p.TAB_R, 0, 0])], 'EvenOdd');
  return { face, outline: face.add(tab) };
}

const grow = (cs, d, seg = SEG) => cs.offset(d, 'Round', 2, seg);
const ringArea = r => { let a = 0; for (let i = 0, n = r.length; i < n; i++) a += r[i][0] * r[(i + 1) % n][1] - r[(i + 1) % n][0] * r[i][1]; return a / 2; };
const arrays = m => ({ positions: m.vertProperties, indices: m.triVerts });

export function toSTL({ positions: v, indices: t }) {
  const n = t.length / 3, buf = new ArrayBuffer(84 + 50 * n), dv = new DataView(buf);
  dv.setUint32(80, n, true);
  for (let i = 0, o = 84; i < n; i++, o += 50) {
    const a = t[3 * i] * 3, b = t[3 * i + 1] * 3, c = t[3 * i + 2] * 3;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
    const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, l = Math.hypot(nx, ny, nz) || 1;
    [nx / l, ny / l, nz / l, v[a], v[a + 1], v[a + 2], v[b], v[b + 1], v[b + 2], v[c], v[c + 1], v[c + 2]]
      .forEach((f, k) => dv.setFloat32(o + 4 * k, f, true));
  }
  return new Uint8Array(buf);
}

// shapes: [{ rings: [[[x,y],...],...], fillRule?: 'EvenOdd'|'NonZero', simplify?: mm }] in panel mm,
// x centred, y up from the bottom of the face.
// ponytail: manifold objects are never .delete()d, so the wasm heap grows by up to about 28 MB per build;
// the page re-creates the module once wasm.HEAPU8.length passes its HEAP_LIMIT. Delete them if that is ever too slow.
export function buildPanel(wasm, shapes = [], p = P) {
  const { Manifold, CrossSection } = wasm;
  const warnings = [];
  const { face, outline } = outline2d(wasm, p);
  const steps = Math.round(p.CHAMFER / p.STEP), flat = p.BODY - p.CHAMFER;
  const parts = [outline.extrude(flat)];
  for (let i = 0; i < steps; i++)
    parts.push(grow(outline, -(i + 1) * p.STEP).extrude(p.STEP).translate([0, 0, flat + i * p.STEP]));
  let relief = null, thin = null;
  for (const s of shapes) {
    const rings = (s.rings || []).filter(r => r.length >= 3);
    if (!rings.length) continue;
    let cs = new CrossSection(rings, s.fillRule || 'EvenOdd');
    if (s.simplify) cs = cs.simplify(s.simplify);
    relief = relief ? relief.add(cs) : cs;
  }
  if (relief && !relief.isEmpty()) {
    const inside = relief.intersect(grow(face, -p.MARGIN));
    if (inside.area() < relief.area() - 0.01)
      warnings.push({ code: 'clipped', message: 'Part of the design is outside the printable area and was cut off. Make it smaller or move it.' });
    // Shapes that touch only at a point (diagonal squares of a QR code or pixel art) would share a vertical
    // edge: the STL is then not watertight once a slicer welds its vertices. Pulling the outline in by
    // 0.01 mm parts them. Inward so the relief stays inside the margin; mitred so no points are added.
    relief = inside.offset(-0.01, 'Miter');
  }
  if (relief && !relief.isEmpty()) {
    // Opening by half the minimum width removes anything too thin; what is lost is the thin part.
    // The -0.01/+0.01 only cuts the arc-rounding slivers (under 0.006 mm) that would string corner tips
    // together; a real hairline is far wider than that and stays.
    // 16 segments per circle here: the check runs in less than half the time and the limit moves by under 2%.
    const r = p.MIN_FEATURE / 2, g = (cs, d) => grow(cs, d, 16);
    // Of what is lost, corner tips are left out: only pieces of at least THIN_AREA count, plus
    // small islands (dots) that are too thin as a whole, whatever their area. Pieces are taken as
    // outlines (outer ones run counter-clockwise, holes clockwise and are kept): decompose() overflows
    // the wasm stack on a few thousand detailed pieces.
    const pieces = g(g(relief.subtract(g(g(relief, -r), r)), -0.01), 0.01).toPolygons().filter(c => { const a = ringArea(c); return a < 0 || a >= p.THIN_AREA; });
    const dots = relief.toPolygons().filter(c => { const a = ringArea(c); return a > 0 && a < 1.5 * p.THIN_AREA && g(new CrossSection([c], 'Positive'), -r).isEmpty(); });
    const lost = [pieces, dots].filter(a => a.length).map(a => new CrossSection(a, 'Positive')).filter(c => !c.isEmpty());
    if (lost.length) {
      thin = lost.reduce((a, b) => a.add(b));
      warnings.push({ code: 'thin', message: `Details shown in red are thinner than ${p.MIN_FEATURE} mm and may not print with a 0.4 mm nozzle.` });
    }
    parts.push(relief.extrude(p.RELIEF + p.SINK).translate([0, 0, p.BODY - p.SINK]));
  }
  // Body first, relief last: one union of all five parts is about three times slower for a detailed relief.
  const body = Manifold.union(parts.slice(0, steps + 1));
  const solid = parts.length > steps + 1 ? body.add(parts[steps + 1]) : body;
  const mesh = arrays(solid.getMesh());
  const thinMesh = thin ? arrays(thin.extrude(0.05).translate([0, 0, p.BODY + p.RELIEF]).getMesh()) : null;
  return { mesh, thinMesh, warnings, stl: toSTL(mesh), bodies: solid.decompose().length };
}
