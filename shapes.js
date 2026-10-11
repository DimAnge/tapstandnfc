// 2D shape helpers. No DOM here: this file runs in the browser and in Node.

// opentype-style path commands (M L Q C Z, absolute) -> closed rings. seg = target segment length.
export function flatten(cmds, seg = 0.25) {
  const rings = []; let ring = null, x = 0, y = 0;
  const count = (...p) => { let d = 0; for (let i = 2; i < p.length; i += 2) d += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]); return Math.max(2, Math.min(48, Math.ceil(d / seg))); };
  for (const c of cmds) {
    if (c.type === 'Z') { if (ring) rings.push(ring); ring = null; continue; }
    if (c.type === 'M') { if (ring) rings.push(ring); ring = [[c.x, c.y]]; }
    else if (!ring) continue;
    else if (c.type === 'L') ring.push([c.x, c.y]);
    else if (c.type === 'Q') {
      const n = count(x, y, c.x1, c.y1, c.x, c.y);
      for (let i = 1; i <= n; i++) { const t = i / n, u = 1 - t; ring.push([u * u * x + 2 * u * t * c.x1 + t * t * c.x, u * u * y + 2 * u * t * c.y1 + t * t * c.y]); }
    } else if (c.type === 'C') {
      const n = count(x, y, c.x1, c.y1, c.x2, c.y2, c.x, c.y);
      for (let i = 1; i <= n; i++) {
        const t = i / n, u = 1 - t, a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
        ring.push([a * x + b * c.x1 + d * c.x2 + e * c.x, a * y + b * c.y1 + d * c.y2 + e * c.y]);
      }
    }
    x = c.x; y = c.y;
  }
  if (ring) rings.push(ring);
  return rings.filter(r => r.length >= 3);
}

// Text outlines sized by cap height. y points down (font convention); place() flips it.
export function textRings(font, text, capMm) {
  const os2 = font.tables.os2, cap = os2 && os2.sCapHeight ? os2.sCapHeight / font.unitsPerEm : 0.7;
  return flatten(font.getPath(text, 0, 0, capMm / cap).commands);
}

export function missingGlyphs(font, text) {
  return [...new Set([...text].filter(ch => ch.trim() && font.charToGlyph(ch).index === 0))];
}

// Scale to `width` (or shrink to `maxWidth`) and centre the bounding box on (cx, cy).
export function place(rings, { width, maxWidth, cx, cy, flipY = false }) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const r of rings) for (const [x, y] of r) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x0 === Infinity) return { rings: [], scale: 1 };
  const w = x1 - x0 || 1;
  let scale = width ? width / w : 1;
  if (maxWidth && w * scale > maxWidth) scale = maxWidth / w;
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, f = flipY ? -1 : 1;
  return { rings: rings.map(r => r.map(([x, y]) => [(x - mx) * scale + cx, f * (y - my) * scale + cy])), scale };
}

// Ramer-Douglas-Peucker on closed rings: drop every point within `tol` of the outline that is left.
// The corners of a traced pixel staircase lie within one pixel of the true edge, so tol = 1 (pixel)
// turns staircases into straight runs and keeps real corners. Rings that collapse are dropped.
export function simplify(rings, tol) {
  const out = [];
  for (const r of rings) {
    const n = r.length; let far = 0, best = 0;
    for (let i = 1; i < n; i++) { const d = (r[i][0] - r[0][0]) ** 2 + (r[i][1] - r[0][1]) ** 2; if (d > best) { best = d; far = i; } }
    if (!far) continue;
    const keep = new Uint8Array(n); keep[0] = keep[far] = 1;
    const stack = [[0, far], [far, n]];             // index n is point 0 again
    while (stack.length) {
      const [a, b] = stack.pop(), [ax, ay] = r[a], [bx, by] = r[b % n], dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
      let worst = tol, at = -1;
      for (let i = a + 1; i < b; i++) { const d = Math.abs((r[i][0] - ax) * dy - (r[i][1] - ay) * dx) / len; if (d > worst) { worst = d; at = i; } }
      if (at >= 0) { keep[at] = 1; stack.push([a, at], [at, b]); }
    }
    const s = r.filter((_, i) => keep[i]);
    if (s.length >= 3) out.push(s);
  }
  return out;
}

// Drop rings smaller than `min` in both directions: islands too small to print and pinholes that
// would close up anyway. With the even-odd rule, dropping a hole's ring fills the hole.
export function dropSpecks(rings, min) {
  return rings.filter(r => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of r) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return x1 - x0 >= min || y1 - y0 >= min;
  });
}

// Place a simplified trace and say whether it can be built: specks under `speck` are dropped, and what
// is left must be something ('specks' if not) with at most maxPoints points ('detailed' if not).
export function fitLogo(rings, opts, speck, maxPoints) {
  const kept = dropSpecks(place(rings, opts).rings, speck);
  let n = 0; for (const r of kept) n += r.length;
  return { rings: kept, problem: !kept.length ? 'specks' : n > maxPoints ? 'detailed' : '' };
}

// RGBA pixels -> ink mask. Dark opaque pixels are ink. If the image has transparency and almost
// nothing is dark (a white logo on a transparent background), the opaque pixels are the ink instead.
export function maskFromRGBA(data, w, h, threshold = 128, invert = false) {
  const n = w * h, mask = new Uint8Array(n);
  let dark = 0, opaque = 0;
  for (let i = 0; i < n; i++) {
    const o = data[4 * i + 3] > 127; opaque += o;
    if (o && 0.299 * data[4 * i] + 0.587 * data[4 * i + 1] + 0.114 * data[4 * i + 2] < threshold) { mask[i] = 1; dark++; }
  }
  if (opaque < n && dark < 0.005 * n) for (let i = 0; i < n; i++) mask[i] = data[4 * i + 3] > 127 ? 1 : 0;
  if (invert) for (let i = 0; i < n; i++) mask[i] ^= 1;
  return mask;
}

// Most pixel edges a trace may have. Tracing and simplifying cost about 1 and up to 3 microseconds per
// edge, so an image just under this takes well under a second; the noisy test photo has 219,000.
export const MAX_EDGES = 300000;

// Ink mask -> boundary loops along pixel edges (corner coordinates, y down). Fill with EvenOdd.
// Returns null as soon as the boundary has more than maxEdges pixel edges.
export function traceMask(mask, w, h, maxEdges = Infinity) {
  const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x];
  const W1 = w + 1, next = new Map();
  let edges = 0;
  const edge = (x0, y0, x1, y1) => { const k = y0 * W1 + x0; if (!next.has(k)) next.set(k, []); next.get(k).push(y1 * W1 + x1); edges++; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (edges > maxEdges) return null;
    if (!at(x, y)) continue;
    if (!at(x, y - 1)) edge(x, y, x + 1, y);
    if (!at(x + 1, y)) edge(x + 1, y, x + 1, y + 1);
    if (!at(x, y + 1)) edge(x + 1, y + 1, x, y + 1);
    if (!at(x - 1, y)) edge(x, y + 1, x, y);
  }
  const rings = [];
  for (const [start, outs] of next) while (outs.length) {
    const ring = []; let v = start;
    do { ring.push([v % W1, Math.floor(v / W1)]); v = next.get(v).pop(); } while (v !== start);
    // keep only the corners of the staircase
    const n = ring.length;
    rings.push(ring.filter(([x, y], i) => {
      const [ax, ay] = ring[(i + n - 1) % n], [bx, by] = ring[(i + 1) % n];
      return (x - ax) * (by - y) !== (y - ay) * (bx - x);
    }));
  }
  return rings;
}
