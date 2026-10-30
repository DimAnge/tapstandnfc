import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { init, buildPanel, outline2d, P, MAX_POINTS } from './core.js';
import { parse as parseFont } from './vendor/opentype.module.js';
import { inflateRawSync, deflateRawSync, crc32 } from 'node:zlib';
import { project3mf, stlToMesh, plateOrigin, tabEars } from './threemf.js';
import { flatten, textRings, missingGlyphs, place, maskFromRGBA, traceMask, simplify, dropSpecks, fitLogo, MAX_EDGES } from './shapes.js';

const wasm = await init();
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;

function bounds({ positions: v }) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i++) { lo[i % 3] = Math.min(lo[i % 3], v[i]); hi[i % 3] = Math.max(hi[i % 3], v[i]); }
  return { lo, hi };
}
function zLevels({ positions: v }) {
  const s = new Set(); for (let i = 2; i < v.length; i += 3) s.add(Math.round(v[i] * 100) / 100); return [...s].sort((a, b) => a - b);
}
function closed({ positions: v, indices: t }) { // as a slicer sees it: vertices welded by position, every edge used exactly twice, no zero-area triangle
  const ids = new Map(), id = i => { const k = `${Math.round(v[3 * i] * 1e4)},${Math.round(v[3 * i + 1] * 1e4)},${Math.round(v[3 * i + 2] * 1e4)}`; if (!ids.has(k)) ids.set(k, ids.size); return ids.get(k); };
  const n = new Map();
  for (let i = 0; i < t.length; i += 3) {
    const [a, b, c] = [3 * t[i], 3 * t[i + 1], 3 * t[i + 2]];
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2], wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
    if (Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) < 1e-9) return false;
    for (let k = 0; k < 3; k++) {
      const p = id(t[i + k]), q = id(t[i + (k + 1) % 3]), key = p < q ? `${p},${q}` : `${q},${p}`;
      n.set(key, (n.get(key) || 0) + 1);
    }
  }
  return [...n.values()].every(c => c === 2);
}
function stlVerts(u8) { // binary STL -> [[x,y,z],...]
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), n = dv.getUint32(80, true), out = [];
  assert.equal(u8.byteLength, 84 + 50 * n, 'STL length matches triangle count');
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
    const o = 84 + 50 * i + 12 + 12 * k; out.push([dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)]);
  }
  return out;
}
function checkSolid(out, zTop) {
  const b = bounds(out.mesh);
  assert.ok(near(b.lo[0], -84) && near(b.hi[0], 84), 'x spans -84..84');
  assert.ok(near(b.lo[1], -6) && near(b.hi[1], 100), 'y spans -6..100');
  assert.ok(near(b.lo[2], 0) && near(b.hi[2], zTop), `z spans 0..${zTop}`);
  assert.equal(out.bodies, 1, 'single solid');
  assert.ok(closed(out.mesh), 'mesh is closed');
  for (const z of zLevels(out.mesh)) assert.ok([0, 3.4, 3.6, 3.8, 4, 5.2].includes(z), `unexpected z level ${z}`);
  assert.equal(stlVerts(out.stl).length, out.mesh.indices.length);
}
const sq = (x0, y0, x1, y1) => ({ rings: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]] });

// ---- Task 1: blank panel
{
  const out = buildPanel(wasm);
  checkSolid(out, 4);
  assert.deepEqual(out.warnings, []);
  assert.deepEqual(zLevels(out.mesh), [0, 3.4, 3.6, 3.8, 4]);

  // The outline matches the panel that is known to fit the base, at the bottom and at every chamfer step.
  // The fixture holds that panel's outline ring at each level; a level's outline here is the horizontal
  // edge of each wall triangle that ends at that height (starts there, for z = 0).
  const fx = JSON.parse(readFileSync(new URL('./panel_outline.fixture.json', import.meta.url), 'utf8'));
  const { positions: v, indices: t } = out.mesh;
  const far = (pts, segs) => { // largest distance from any of pts to the nearest of segs
    let worst = 0;
    for (const [px, py] of pts) {
      let best = Infinity;
      for (const [[ax, ay], [bx, by]] of segs) {
        const dx = bx - ax, dy = by - ay, u = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
        best = Math.min(best, Math.hypot(px - ax - u * dx, py - ay - u * dy));
      }
      worst = Math.max(worst, best);
    }
    return worst;
  };
  assert.deepEqual(fx.levels.map(l => l.z), [0, 3.4, 3.6, 3.8, 4]);
  for (const { z, ring } of fx.levels) {
    const mine = [];
    for (let i = 0; i < t.length; i += 3) {
      const p = [0, 1, 2].map(k => [v[3 * t[i + k]], v[3 * t[i + k] + 1], v[3 * t[i + k] + 2]]);
      const at = p.filter(q => near(q[2], z)), off = p.filter(q => !near(q[2], z));
      if (at.length === 2 && (off[0][2] > z) === (z === 0)) mine.push(at);
    }
    assert.ok(mine.length >= 100, `no outline found at z ${z}`);
    const theirs = ring.map((q, i) => [q, ring[(i + 1) % ring.length]]);
    const d = Math.max(far(ring, mine), far(mine.flat(), theirs));
    assert.ok(d < fx.tolerance, `outline at z ${z} differs from the reference panel by ${d.toFixed(3)} mm`);
  }
  console.log('ok  blank panel');
}

// ---- Task 2: relief
{
  const reliefVerts = out => { const v = out.mesh.positions, r = []; for (let i = 0; i < v.length; i += 3) if (v[i + 2] > 4.01) r.push([v[i], v[i + 1]]); return r; };

  let out = buildPanel(wasm, [sq(-20, 40, 20, 60)]);
  checkSolid(out, 5.2);
  assert.deepEqual(out.warnings, []);
  assert.equal(out.thinMesh, null);

  // Review Focus 4: bigger than the face -> cut at the margin, with a warning
  out = buildPanel(wasm, [sq(-200, -200, 200, 200)]);
  checkSolid(out, 5.2);
  assert.ok(out.warnings.some(w => w.code === 'clipped'));
  for (const [x, y] of reliefVerts(out)) assert.ok(Math.abs(x) <= 78.01 && y >= 5.99 && y <= 94.01, `relief outside margin at ${x},${y}`);

  // thin check: 0.5 mm bar warns, 0.7 mm and 1.0 mm bars do not (0.74 mm details are known to print)
  out = buildPanel(wasm, [sq(-10, 50, 10, 50.5)]);
  assert.ok(out.warnings.some(w => w.code === 'thin')); assert.ok(out.thinMesh.indices.length > 0);
  for (const h of [0.7, 1]) assert.deepEqual(buildPanel(wasm, [sq(-10, 50, 10, 50 + h)]).warnings, [], `${h} mm bar must not warn`);

  // Review Focus 5: overlapping, corner-touching, degenerate and empty shapes
  checkSolid(buildPanel(wasm, [sq(-20, 40, 5, 60), sq(-5, 50, 20, 70)]), 5.2);
  checkSolid(buildPanel(wasm, [sq(0, 40, 10, 50), sq(10, 50, 20, 60)]), 5.2);
  checkSolid(buildPanel(wasm, [{ rings: [[[0, 0], [1, 1]]] }, { rings: [] }]), 4);
  // a QR-like logo (modules touching only at corners), traced as the page does it, is still one watertight solid
  {
    const N = 29, K = 20, mask = new Uint8Array(N * K * N * K), on = []; let seed = 7;
    for (let i = 0; i < N * N; i++) on.push((seed = (seed * 1664525 + 1013904223) >>> 0) < 2 ** 31);
    for (let y = 0; y < N * K; y++) for (let x = 0; x < N * K; x++) mask[y * N * K + x] = on[Math.floor(y / K) * N + Math.floor(x / K)] ? 1 : 0;
    const fit = fitLogo(simplify(traceMask(mask, N * K, N * K, MAX_EDGES), 1), { width: 70, cx: 0, cy: 50, flipY: true }, P.MIN_FEATURE / 2, MAX_POINTS);
    assert.equal(fit.problem, '');
    out = buildPanel(wasm, [{ rings: fit.rings, fillRule: 'EvenOdd' }]);
    checkSolid(out, 5.2);
    assert.deepEqual(out.warnings, []);
  }
  // staircase input with simplify still gives a clean solid
  const stairs = []; for (let i = 0; i < 40; i++) stairs.push([i * 0.1, 40 + i * 0.1], [(i + 1) * 0.1, 40 + i * 0.1]);
  stairs.push([4, 30], [0, 30]);
  checkSolid(buildPanel(wasm, [{ rings: [stairs], simplify: 0.08 }]), 5.2);
  console.log('ok  relief');
}

// ---- Task 3: shapes
{
  const area = rings => Math.abs(rings.reduce((s, r) => s + r.reduce((a, [x, y], i) => { const [u, v] = r[(i + 1) % r.length]; return a + x * v - u * y; }, 0) / 2, 0));
  const font = f => { const b = readFileSync(new URL(`./vendor/fonts/${f}`, import.meta.url)); return parseFont(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
  const poppins = font('Poppins-Bold.ttf'), noto = font('NotoSans-Bold.ttf');

  // flatten: a quarter-circle-ish cubic stays within its hull and closes
  const r = flatten([{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 10, y: 0 }, { type: 'C', x1: 10, y1: 5.5, x2: 5.5, y2: 10, x: 0, y: 10 }, { type: 'Z' }]);
  assert.equal(r.length, 1); assert.ok(r[0].length > 10); assert.ok(area(r) > 70 && area(r) < 80);

  // text: cap height is what was asked for (Poppins "H", y down so the top is negative)
  const H = textRings(poppins, 'H', 10).flat();
  assert.ok(near(Math.max(...H.map(p => p[1])) - Math.min(...H.map(p => p[1])), 10, 0.3));

  // several lines: stacked 1.6 cap heights apart, each centred on x = 0; maxHeight shrinks a tall block
  const two = textRings(poppins, 'HHHH\nH', 10), ys = two.flat().map(p => p[1]), top = two.filter(r => r[0][1] <= 0).flat(), low = two.filter(r => r[0][1] > 0).flat();
  assert.equal(two.length, 5);
  assert.ok(near(Math.max(...ys) - Math.min(...ys), 26, 0.5));
  for (const row of [top, low]) assert.ok(near(Math.max(...row.map(p => p[0])) + Math.min(...row.map(p => p[0])), 0, 0.5));
  assert.ok(near(place(two, { maxWidth: 150, maxHeight: 13, cx: 0, cy: 0 }).scale, 0.5, 0.02));

  // Review Focus 3: missing characters are named; whitespace is not "missing"
  assert.deepEqual(missingGlyphs(poppins, 'ΧΟΡΟΣ dance'), ['Χ', 'Ο', 'Ρ', 'Σ']);
  assert.deepEqual(missingGlyphs(noto, 'ΧΟΡΟΣ χορός'), []);
  assert.ok(missingGlyphs(poppins, 'hi 😀').length === 1);

  // place: width, maxWidth, centre and flip
  let pl = place([[[0, 0], [4, 0], [4, 2], [0, 2]]], { width: 40, cx: 0, cy: 50, flipY: true });
  assert.equal(pl.scale, 10);
  assert.deepEqual(pl.rings[0][0], [-20, 60]); assert.deepEqual(pl.rings[0][2], [20, 40]);
  pl = place([[[0, 0], [4, 0], [4, 2], [0, 2]]], { maxWidth: 2, cx: 0, cy: 0 });
  assert.equal(pl.scale, 0.5);
  assert.deepEqual(place([], { width: 10, cx: 0, cy: 0 }), { rings: [], scale: 1 });

  // mask: dark on white; Review Focus 2: white on transparent uses alpha; invert
  const px = (list) => new Uint8ClampedArray(list.flat());
  const W = [255, 255, 255, 255], K = [0, 0, 0, 255], T = [0, 0, 0, 0], WT = [255, 255, 255, 255];
  assert.deepEqual([...maskFromRGBA(px([W, K, K, W]), 2, 2)], [0, 1, 1, 0]);
  assert.deepEqual([...maskFromRGBA(px([T, WT, WT, T]), 2, 2)], [0, 1, 1, 0]);
  assert.deepEqual([...maskFromRGBA(px([W, K, K, W]), 2, 2, 128, true)], [1, 0, 0, 1]);

  // trace: square -> 4 corners; ring -> 2 loops; corner-touching pixels terminate; empty -> nothing
  const grid = (w, h, fn) => { const m = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = fn(x, y) ? 1 : 0; return m; };
  let t = traceMask(grid(10, 10, (x, y) => x >= 3 && x < 7 && y >= 3 && y < 7), 10, 10);
  assert.equal(t.length, 1); assert.equal(t[0].length, 4); assert.equal(area(t), 16);
  t = traceMask(grid(10, 10, (x, y) => x >= 2 && x < 8 && y >= 2 && y < 8 && !(x >= 4 && x < 6 && y >= 4 && y < 6)), 10, 10);
  assert.equal(t.length, 2);
  t = traceMask(grid(4, 4, (x, y) => (x === 1 && y === 1) || (x === 2 && y === 2)), 4, 4);
  assert.equal(t.flat().length, 8);
  assert.deepEqual(traceMask(grid(4, 4, () => false), 4, 4), []);

  // end to end: text and a traced blob become one valid panel
  const blob = place(traceMask(grid(200, 100, (x, y) => (x - 100) ** 2 / 4 + (y - 50) ** 2 < 1600), 200, 100), { width: 80, cx: 0, cy: 60, flipY: true });
  const label = place(textRings(poppins, '@yourhandle', 6), { maxWidth: 150, cx: 0, cy: 18, flipY: true });
  checkSolid(buildPanel(wasm, [
    { rings: blob.rings, fillRule: 'EvenOdd', simplify: 0.75 * blob.scale },
    { rings: label.rings, fillRule: 'NonZero' },
  ]), 5.2);
  // place() must not throw on very large inputs (no argument spreading)
  {
    const big = []; for (let i = 0; i < 100000; i++) { const x = (i % 500) * 2, y = Math.floor(i / 500) * 2; big.push([[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]]); }
    const bp = place(big, { width: 100, cx: 0, cy: 50, flipY: true });
    const px = bp.rings.flat(); let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    for (const [x, y] of px) { lo = [Math.min(lo[0], x), Math.min(lo[1], y)]; hi = [Math.max(hi[0], x), Math.max(hi[1], y)]; }
    assert.ok(near(bp.scale, 100 / 999) && near(hi[0] - lo[0], 100) && near((lo[0] + hi[0]) / 2, 0) && near((lo[1] + hi[1]) / 2, 50));
  }

  // the example the page starts with (its own slider defaults) has nothing to warn about
  {
    const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
    const val = id => +html.match(new RegExp(`id="${id}"[^>]*value="([\\d.]+)"`))[1];
    const eg = place(textRings(poppins, html.match(/id="text" placeholder="([^"]+)"/)[1], val('textH')), { maxWidth: P.W - 2 * P.MARGIN - 4, cx: 0, cy: val('textY'), flipY: true });
    assert.deepEqual(buildPanel(wasm, [{ rings: eg.rings, fillRule: 'NonZero' }]).warnings, []);
  }

  // thin check: sharp corner tips are not "too thin"; they just print rounded
  {
    const thin = shapes => buildPanel(wasm, shapes).warnings.some(w => w.code === 'thin');
    const txt = (t, h, cy) => ({ rings: place(textRings(poppins, t, h), { maxWidth: 150, cx: 0, cy, flipY: true }).rings, fillRule: 'NonZero' });
    assert.deepEqual(buildPanel(wasm, [txt('YOUR LOGO', 18, 58), txt('@yourhandle', 6, 18)]).warnings, [], 'the sample panel has no warnings');
    for (const t of ['KQRX', 'kxyvw']) for (const h of [10, 20]) assert.ok(!thin([txt(t, h, 50)]), `"${t}" at ${h} mm must not warn`);
    const tri = (base, h) => ({ rings: [[[-base / 2, 30], [base / 2, 30], [0, 30 + h]]] });
    const circle = (r, n = 96) => Array.from({ length: n }, (_, i) => [r * Math.cos(2 * Math.PI * i / n), 50 + r * Math.sin(2 * Math.PI * i / n)]);
    // ordinary tips: 41 degrees, and the 36 degrees of a five-pointed star
    assert.ok(!thin([tri(6, 8)]), '41 degree tip must not warn');
    assert.ok(!thin([tri(13, 20)]), '36 degree tip must not warn');
    // a needle is under 0.6 mm wide for its last 3 mm, like the short bar below, and loses its end in print
    assert.ok(thin([tri(6, 30)]), '11 degree needle must warn');
    // still warns: short thin bar, thin line art, and a dot that is too small as a whole
    assert.ok(thin([sq(-1.5, 50, 1.5, 50.5)]), '0.5 x 3 mm bar must warn');
    assert.ok(thin([{ rings: [circle(15), circle(14.6)] }]), 'ring with a 0.4 mm stroke must warn');
    assert.ok(thin([sq(-20, 70, 20, 80), { rings: [circle(0.2, 24)] }]), '0.4 mm dot beside a thick shape must warn');
    // hairlines are the least printable of all: alone, or attached to a thick block
    for (const w of [0.1, 0.15, 0.19]) assert.ok(thin([sq(-10, 50, 10, 50 + w)]), `${w} x 20 mm bar must warn`);
    assert.ok(thin([sq(-10, 40, 10, 60), sq(10, 50, 25, 50.15)]), '0.15 mm line attached to a block must warn');
  }

  // specks: a ring too small to print is dropped, the same shape at a printable size is kept
  {
    const dot = s => [[0, 0], [s, 0], [s, s], [0, s]], big = [[-5, -5], [5, -5], [5, 5], [-5, 5]];
    assert.deepEqual(dropSpecks([big, dot(0.2), dot(0.5), [[0, 0], [3, 0], [3, 0.1], [0, 0.1]]], 0.3), [big, dot(0.5), [[0, 0], [3, 0], [3, 0.1], [0, 0.1]]]);
    // a pinhole in a solid square closes up; the panel is the same as for the plain square
    const a = buildPanel(wasm, [{ rings: dropSpecks([[[-10, 40], [10, 40], [10, 60], [-10, 60]], [[0, 50], [0.2, 50], [0.2, 50.2], [0, 50.2]]], 0.3) }]);
    assert.equal(a.mesh.indices.length, buildPanel(wasm, [sq(-10, 40, 10, 60)]).mesh.indices.length);
  }

  // fitLogo: a logo that is all specks at this width is a problem, not a silent blank panel
  {
    const dots = []; for (let i = 0; i < 50; i++) { const x = (i % 10) * 10, y = Math.floor(i / 10) * 10; dots.push([[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]]); }
    const at = width => fitLogo(dots, { width, cx: 0, cy: 50, flipY: true }, P.MIN_FEATURE / 2, MAX_POINTS);   // 91 units wide
    assert.deepEqual(at(18.2), { rings: [], problem: 'specks' });                  // dots of 0.2 mm
    const ok = at(45.5); assert.equal(ok.problem, ''); assert.equal(ok.rings.length, 50);   // dots of 0.5 mm
    assert.equal(fitLogo(dots, { width: 45.5, cx: 0, cy: 50 }, P.MIN_FEATURE / 2, 100).problem, 'detailed');
  }

  // trace limit: a full-frame checkerboard is given up on early instead of traced and simplified
  {
    const t0 = performance.now();
    assert.equal(traceMask(grid(1600, 1200, (x, y) => (x + y) % 2), 1600, 1200, MAX_EDGES), null);
    assert.ok(performance.now() - t0 < 3000, 'giving up on a checkerboard must be quick');
    const disc = grid(100, 100, (x, y) => (x - 50) ** 2 + (y - 50) ** 2 < 900);
    assert.deepEqual(traceMask(disc, 100, 100, MAX_EDGES), traceMask(disc, 100, 100));
  }

  // simplify: the pixel staircase of a traced disc goes away, the shape stays
  {
    const raw = traceMask(grid(400, 400, (x, y) => (x - 200) ** 2 + (y - 200) ** 2 < 150 ** 2), 400, 400), smooth = simplify(raw, 1);
    assert.ok(raw[0].length > 600 && smooth.flat().length < 120, `disc ${raw[0].length} -> ${smooth.flat().length} points`);
    assert.ok(near(area(smooth), Math.PI * 150 ** 2, 0.005 * Math.PI * 150 ** 2));
    // real corners stay exactly where they are; a ring that collapses is dropped
    assert.deepEqual(simplify([[[0, 0], [5, 0], [10, 0], [10, 10], [0, 10]], [[0, 0], [1, 0], [1, 1], [0, 1]]], 1), [[[0, 0], [10, 0], [10, 10], [0, 10]]]);
    assert.deepEqual(simplify([], 1), []);
  }

  // noisy images: smooth random blobs, traced as the page does it (1600 px, simplify, place, drop specks).
  // Whatever is under the point cap must build quickly; the rest is refused by the cap.
  // Measured in Node 22: about 12,000 points of such noise build in 2 s, 35,000 in 8.5 s.
  {
    const blobs = (cell, seed) => { // value noise: random lattice every `cell` px, bilinear in between, cut at 0.5
      const w = 1600, h = 1200, gw = Math.ceil(w / cell) + 2, g = new Float32Array(gw * (Math.ceil(h / cell) + 2));
      for (let i = 0; i < g.length; i++) g[i] = (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
      return grid(w, h, (x, y) => { const u = x / cell, v = y / cell, i = Math.floor(u), j = Math.floor(v), a = u - i, b = v - j, k = j * gw + i;
        return g[k] * (1 - a) * (1 - b) + g[k + 1] * a * (1 - b) + g[k + gw] * (1 - a) * b + g[k + gw + 1] * a * b < 0.5; });
    };
    const prep = (mask, width) => {
      const fit = fitLogo(simplify(traceMask(mask, 1600, 1200, MAX_EDGES), 1), { width, cx: 0, cy: 58, flipY: true }, P.MIN_FEATURE / 2, MAX_POINTS);
      let n = 0; for (const r of fit.rings) n += r.length;
      return { ...fit, n };
    };
    const fine = prep(blobs(8, 1), 110);
    assert.ok(fine.n > MAX_POINTS && fine.problem === 'detailed', `fine noise (${fine.n} points) must be over the cap of ${MAX_POINTS}`);
    const coarse = prep(blobs(18, 1), 110);
    assert.ok(coarse.n > 0.6 * MAX_POINTS && coarse.problem === '', `coarse noise (${coarse.n} points) should sit just under the cap of ${MAX_POINTS}`);
    const t0 = performance.now(), out = buildPanel(wasm, [{ rings: coarse.rings, fillRule: 'EvenOdd' }]), ms = performance.now() - t0;
    checkSolid(out, 5.2);
    assert.ok(ms < 8000, `a design just under the cap took ${ms.toFixed(0)} ms to build`);
    // buildPanel itself must survive more than the page lets through (decompose() overflowed the wasm stack here)
    const over = prep(blobs(12, 1), 110);
    assert.ok(over.n > 1.4 * MAX_POINTS);
    checkSolid(buildPanel(wasm, [{ rings: over.rings, fillRule: 'EvenOdd' }]), 5.2);
  }
  console.log('ok  shapes');
}

// ---- 3MF projects for Bambu Studio
{
  const settings = JSON.parse(readFileSync(new URL('./bambu_settings.json', import.meta.url), 'utf8'));
  const unzip = u8 => {   // minimal reader: checks every entry's CRC and returns name -> text
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), end = u8.length - 22, out = new Map();
    assert.equal(dv.getUint32(end, true), 0x06054b50, 'zip end record');
    let o = dv.getUint32(end + 16, true);
    for (let i = 0; i < dv.getUint16(end + 10, true); i++) {
      assert.equal(dv.getUint32(o, true), 0x02014b50, 'zip central record');
      const method = dv.getUint16(o + 10, true), crc = dv.getUint32(o + 16, true), csize = dv.getUint32(o + 20, true), usize = dv.getUint32(o + 24, true);
      const nlen = dv.getUint16(o + 28, true), local = dv.getUint32(o + 42, true), name = new TextDecoder().decode(u8.subarray(o + 46, o + 46 + nlen));
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const raw = method === 8 ? inflateRawSync(u8.subarray(start, start + csize)) : u8.subarray(start, start + csize);
      assert.equal(raw.length, usize, `${name} size`); assert.equal(crc32(raw), crc, `${name} crc`);
      out.set(name, new TextDecoder().decode(raw));
      o += 46 + nlen + dv.getUint16(o + 30, true) + dv.getUint16(o + 32, true);
    }
    return out;
  };
  const count = (text, re) => (text.match(re) || []).length;

  // settings template: the values the print guide promises, and nothing personal
  assert.equal(settings.layer_height, '0.2'); assert.equal(settings.initial_layer_print_height, '0.2');
  assert.equal(settings.wall_generator, 'arachne'); assert.equal(settings.enable_prime_tower, '0');
  assert.equal(settings.wall_loops, '3'); assert.equal(settings.top_shell_layers, '5'); assert.equal(settings.bottom_shell_layers, '4');
  assert.deepEqual(settings.filament_colour, ['#FFFFFF', '#000000']);
  assert.ok(!/DesignerUserId|@gmail|\/home\//i.test(JSON.stringify(settings)));

  // one panel, as the page makes it
  const panel = buildPanel(wasm, [sq(-20, 40, 20, 60)]);
  for (const [kind, expect] of [['colour', 'type="2" extruder="2" color="#000000" extra="" gcode="tool_change"'], ['pause', 'type="1" extruder="1" color="" extra="" gcode="M400 U1"']]) {
    const files = unzip(project3mf({ settings, objects: [{ name: 'panel', mesh: panel.mesh, plate: 0, cx: 90, cy: 90 }], plates: [{ events: [{ z: 4.2, kind }] }] }));
    assert.equal([...files.keys()][0], '[Content_Types].xml', 'content types come first');
    for (const f of ['_rels/.rels', '3D/3dmodel.model', '3D/_rels/3dmodel.model.rels', '3D/Objects/object_1.model', 'Metadata/model_settings.config', 'Metadata/project_settings.config', 'Metadata/custom_gcode_per_layer.xml'])
      assert.ok(files.has(f), `missing ${f}`);
    assert.ok(files.get('Metadata/custom_gcode_per_layer.xml').includes(`<layer top_z="4.2" ${expect}/>`), `${kind} event at 4.2`);
    const model = files.get('3D/Objects/object_1.model');
    assert.equal(count(model, /<vertex /g), panel.mesh.positions.length / 3); assert.equal(count(model, /<triangle /g), panel.mesh.indices.length / 3);
    // the panel spans x -84..84, y -6..100, so centring it on a 180 mm bed moves it by 90, 43
    assert.ok(files.get('3D/3dmodel.model').includes('transform="1 0 0 0 1 0 0 0 1 90 43 0"'), 'panel centred on the plate, sitting on the bed');
    assert.deepEqual(JSON.parse(files.get('Metadata/project_settings.config')), settings);
    assert.ok(![...files.values()].some(t => /DesignerUserId/.test(t)), 'no user id in the file');
  }

  // several plates, per-object filament and settings, compressed
  assert.deepEqual(plateOrigin(0, 6, 180), [0, 0]); assert.deepEqual(plateOrigin(1, 6, 180), [216, 0]);
  assert.deepEqual(plateOrigin(3, 6, 180), [0, -216]); assert.deepEqual(plateOrigin(0, 1, 180), [0, 0]);
  const spec = { settings, objects: [
    { name: 'a & b', mesh: panel.mesh, plate: 0, cx: 90, cy: 90, filament: 2 },
    { name: 'c', mesh: panel.mesh, plate: 1, cx: 90, cy: 90, settings: { sparse_infill_density: '20%' } },
  ], plates: [{ events: [] }, { events: [{ z: 5.2, kind: 'colour' }, { z: 3.6, kind: 'pause' }] }] };
  const stored = project3mf(spec), packed = project3mf({ ...spec, deflate: deflateRawSync });
  assert.ok(packed.length < stored.length / 3, 'deflate shrinks the file');
  const many = unzip(packed);
  assert.deepEqual([...many], [...unzip(stored)], 'compressed and stored files hold the same content');
  const conf = many.get('Metadata/model_settings.config'), gc = many.get('Metadata/custom_gcode_per_layer.xml');
  assert.ok(conf.includes('<metadata key="name" value="a &amp; b"/>\n    <metadata key="extruder" value="2"/>'));
  assert.ok(conf.includes('<metadata key="sparse_infill_density" value="20%"/>'));
  assert.equal(count(conf, /<plate>/g), 2); assert.equal(count(gc, /<plate>/g), 2);
  assert.ok(gc.indexOf('top_z="3.6" type="1"') > 0 && gc.indexOf('top_z="3.6"') < gc.indexOf('top_z="5.2" type="2"'), 'events sorted by height on plate 2');
  assert.ok(gc.indexOf('<plate_info id="2"/>') < gc.indexOf('top_z="3.6"'), 'events belong to plate 2');
  assert.ok(many.get('3D/3dmodel.model').includes('transform="1 0 0 0 1 0 0 0 1 306 43 0"'), 'second plate is 216 mm to the right');

  // STL -> mesh keeps every triangle and stays closed
  const back = stlToMesh(panel.stl);
  assert.equal(back.indices.length, panel.mesh.indices.length); assert.ok(closed(back));
  // ears: two discs, one layer thick, one past each end of the panel's tab and below it (the tab's lowest y is -6)
  const ears = tabEars(panel.mesh).positions;
  assert.equal(ears.length / 3, 196);
  assert.ok(Math.abs(ears[0] + 64.4) < 1 && Math.abs(ears[98 * 3] - 64.4) < 1 && ears[1] < -6 && ears[98 * 3 + 1] < -6);
  assert.ok(Math.abs(ears[5] - ears[2] - 0.2) < 1e-5);
  console.log('ok  3mf');
}
