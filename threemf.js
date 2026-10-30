// Bambu Studio project (.3mf) writer. No DOM and no Node-only code: runs in the browser and in Node.
// The layout follows projects saved by Bambu Studio 2.3: one model file per object, per-plate
// pauses and colour switches in Metadata/custom_gcode_per_layer.xml, print settings in
// Metadata/project_settings.config.

const enc = new TextEncoder();
const bytes = d => (typeof d === 'string' ? enc.encode(d) : d);

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Zip writer. Without `deflate` the files are stored uncompressed (fine for one panel, 1-2 MB).
// Pass a raw-deflate function (Node: zlib.deflateRawSync) to compress, as the release pack does.
export function zip(files, deflate) {
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), raw = bytes(f.data), crc = crc32(raw);
    const data = deflate ? new Uint8Array(deflate(raw)) : raw, method = deflate ? 8 : 0;
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true);
    head.setUint16(8, method, true); head.setUint16(12, 0x0021, true);   // date 1980-01-01, so output is reproducible
    head.setUint32(14, crc, true); head.setUint32(18, data.length, true); head.setUint32(22, raw.length, true);
    head.setUint16(26, name.length, true);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, method, true); cen.setUint16(14, 0x0021, true);
    cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, raw.length, true);
    cen.setUint16(28, name.length, true); cen.setUint32(42, offset, true);
    parts.push(new Uint8Array(head.buffer), name, data);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, size, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let o = 0; for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}

// Binary STL -> indexed mesh, joining vertices that have identical coordinates.
export function stlToMesh(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), n = dv.getUint32(80, true);
  const seen = new Map(), positions = [], indices = new Uint32Array(n * 3);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
    const o = 84 + 50 * i + 12 + 12 * k;
    const x = dv.getFloat32(o, true), y = dv.getFloat32(o + 4, true), z = dv.getFloat32(o + 8, true), key = `${x},${y},${z}`;
    let id = seen.get(key);
    if (id === undefined) { id = positions.length / 3; seen.set(key, id); positions.push(x, y, z); }
    indices[i * 3 + k] = id;
  }
  return { positions: new Float32Array(positions), indices };
}

// "Mouse ears" for a panel: a one-layer disc (radius r, h tall) on each of the two bottom corners of its tab (the lowest
// y of the footprint), so the tab does not lift off the bed. Each overlaps the tab by only `overlap` mm, so it peels off.
export function tabEars({ positions: v }, r = 5, h = 0.2, overlap = 1.2, n = 48) {
  let y0 = Infinity, z0 = Infinity;
  for (let i = 0; i < v.length; i += 3) { y0 = Math.min(y0, v[i + 1]); z0 = Math.min(z0, v[i + 2]); }
  const foot = [];                               // footprint points on the tab's row
  for (let i = 0; i < v.length; i += 3) if (v[i + 2] < z0 + 0.01 && v[i + 1] < y0 + 2) foot.push([v[i], v[i + 1]]);
  const xs = foot.map(p => p[0]), positions = [], indices = [];
  for (const sx of [-1, 1]) {
    const cx = sx < 0 ? Math.min(...xs) : Math.max(...xs);
    let best = Infinity, px = 0, py = 0;
    for (const [x, y] of foot) { const d = Math.hypot(x - cx, y - y0); if (d < best) { best = d; px = x; py = y; } }
    const out = (r - overlap) * Math.SQRT1_2, ex = px + sx * out, ey = py - out;
    const b = positions.length / 3;              // b, b+1: bottom and top centre; then n bottom/top rim pairs
    positions.push(ex, ey, z0, ex, ey, z0 + h);
    for (let k = 0; k < n; k++) { const a = 2 * Math.PI * k / n, x = ex + r * Math.cos(a), y = ey + r * Math.sin(a); positions.push(x, y, z0, x, y, z0 + h); }
    for (let k = 0; k < n; k++) {
      const lo = b + 2 + 2 * k, hi = lo + 1, lo2 = b + 2 + 2 * ((k + 1) % n), hi2 = lo2 + 1;
      indices.push(b, lo2, lo, b + 1, hi, hi2, lo, lo2, hi2, lo, hi2, hi);
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = v => String(Math.round(v * 1e5) / 1e5);
const uuid = (a, b) => `${String(a).padStart(8, '0')}-0000-4000-8000-${String(b).padStart(12, '0')}`;
const XML = '<?xml version="1.0" encoding="UTF-8"?>\n';
const NS = 'unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p"';

// Where Bambu Studio puts plate i (0-based) of n: a grid, each cell 1.2 beds apart, rows going down.
export function plateOrigin(i, n, bed) {
  const cols = Math.ceil(Math.sqrt(n));
  return [(i % cols) * bed * 1.2, -Math.floor(i / cols) * bed * 1.2 || 0];   // || 0 turns -0 into 0
}

// objects: [{ name, mesh: {positions, indices}, plate: 0-based, cx, cy, filament?: 1|2, settings?: {key: value}, parts? }]
//          cx, cy = where the centre of the object's footprint goes on its plate (mm from the plate corner).
//          parts = [{ name, mesh }] more meshes in the same object, kept where they are relative to `mesh`
//          (in Bambu Studio they show under the object and can be deleted on their own).
//          settings = print settings that apply to this object only (for example sparse_infill_density).
// plates:  [{ events: [{ z, kind: 'pause' | 'colour' }] }]   z = top of the first layer printed after the event.
// settings: a complete Bambu Studio project_settings object (see bambu_settings.json).
export function project3mf({ objects, plates, settings, bed = 180, deflate }) {
  const files = [], items = [], rels = [], resources = [], conf = [], plateObjs = plates.map(() => []);
  let extraId = 2 * objects.length;                 // ids for the extra parts, after every object's own two
  objects.forEach((ob, k) => {
    const objId = 2 * k + 2, parts = [{ name: ob.name, mesh: ob.mesh }, ...(ob.parts || [])].map((p, j) => ({ ...p, id: j ? ++extraId : 2 * k + 1 }));
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const { mesh: { positions: v } } of parts)
      for (let i = 0; i < v.length; i++) { lo[i % 3] = Math.min(lo[i % 3], v[i]); hi[i % 3] = Math.max(hi[i % 3], v[i]); }
    const [px, py] = plateOrigin(ob.plate, plates.length, bed);
    const tx = px + ob.cx - (lo[0] + hi[0]) / 2, ty = py + ob.cy - (lo[1] + hi[1]) / 2, tz = -lo[2];
    const chunks = [`${XML}<model ${NS}>\n <metadata name="BambuStudio:3mfVersion">1</metadata>\n <resources>\n`];
    for (const { id, mesh: { positions: v, indices: t } } of parts) {
      chunks.push(`  <object id="${id}" p:UUID="${uuid(id, 1)}" type="model">\n   <mesh>\n    <vertices>\n`);
      for (let i = 0; i < v.length; i += 3) chunks.push(`     <vertex x="${num(v[i])}" y="${num(v[i + 1])}" z="${num(v[i + 2])}"/>\n`);
      chunks.push('    </vertices>\n    <triangles>\n');
      for (let i = 0; i < t.length; i += 3) chunks.push(`     <triangle v1="${t[i]}" v2="${t[i + 1]}" v3="${t[i + 2]}"/>\n`);
      chunks.push('    </triangles>\n   </mesh>\n  </object>\n');
    }
    chunks.push(' </resources>\n <build/>\n</model>\n');
    const path = `/3D/Objects/object_${k + 1}.model`;
    files.push({ name: path.slice(1), data: chunks.join('') });
    rels.push(` <Relationship Target="${path}" Id="rel-${k + 1}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n`);
    resources.push(`  <object id="${objId}" p:UUID="${uuid(objId, 2)}" type="model">\n   <components>\n${parts.map(({ id }) => `    <component p:path="${path}" objectid="${id}" p:UUID="${uuid(id, 3)}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>\n`).join('')}   </components>\n  </object>\n`);
    items.push(`  <item objectid="${objId}" p:UUID="${uuid(objId, 4)}" transform="1 0 0 0 1 0 0 0 1 ${num(tx)} ${num(ty)} ${num(tz)}" printable="1"/>\n`);
    conf.push(`  <object id="${objId}">\n    <metadata key="name" value="${esc(ob.name)}"/>\n    <metadata key="extruder" value="${ob.filament || 1}"/>\n${Object.entries(ob.settings || {}).map(([key, v]) => `    <metadata key="${esc(key)}" value="${esc(v)}"/>\n`).join('')}${parts.map(({ id, name }) => `    <part id="${id}" subtype="normal_part">\n      <metadata key="name" value="${esc(name)}"/>\n      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n    </part>\n`).join('')}  </object>\n`);
    plateObjs[ob.plate].push(objId);
  });

  const gcodes = plates.map((p, i) => {
    const layers = (p.events || []).slice().sort((a, b) => a.z - b.z).map(e => e.kind === 'pause'
      ? `<layer top_z="${num(e.z)}" type="1" extruder="1" color="" extra="" gcode="${esc(settings.machine_pause_gcode || 'M400 U1')}"/>\n`
      : `<layer top_z="${num(e.z)}" type="2" extruder="2" color="${esc(settings.filament_colour[1])}" extra="" gcode="tool_change"/>\n`);
    return `<plate>\n<plate_info id="${i + 1}"/>\n${layers.join('')}<mode value="MultiAsSingle"/>\n</plate>\n`;
  });
  const plateConf = plateObjs.map((ids, i) => `  <plate>\n    <metadata key="plater_id" value="${i + 1}"/>\n    <metadata key="plater_name" value=""/>\n    <metadata key="locked" value="false"/>\n${ids.map(id => `    <model_instance>\n      <metadata key="object_id" value="${id}"/>\n      <metadata key="instance_id" value="0"/>\n      <metadata key="identify_id" value="${100 + id}"/>\n    </model_instance>\n`).join('')}  </plate>\n`);

  return zip([
    { name: '[Content_Types].xml', data: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n <Default Extension="png" ContentType="image/png"/>\n <Default Extension="gcode" ContentType="text/x.gcode"/>\n</Types>\n` },
    { name: '_rels/.rels', data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n</Relationships>\n` },
    { name: '3D/3dmodel.model', data: `${XML}<model ${NS}>\n <metadata name="Application">BambuStudio-${esc(settings.version)}</metadata>\n <metadata name="BambuStudio:3mfVersion">1</metadata>\n <resources>\n${resources.join('')} </resources>\n <build p:UUID="${uuid(0, 5)}">\n${items.join('')} </build>\n</model>\n` },
    { name: '3D/_rels/3dmodel.model.rels', data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n${rels.join('')}</Relationships>\n` },
    ...files,
    { name: 'Metadata/model_settings.config', data: `${XML}<config>\n${conf.join('')}${plateConf.join('')}</config>\n` },
    { name: 'Metadata/project_settings.config', data: JSON.stringify(settings, null, 4) },
    { name: 'Metadata/custom_gcode_per_layer.xml', data: `<?xml version="1.0" encoding="utf-8"?>\n<custom_gcodes_per_layer>\n${gcodes.join('')}</custom_gcodes_per_layer>\n` },
  ], deflate);
}
