// Writes the two all-in-one Bambu Studio projects for the release: every part on its own plate,
// with the tag pauses and colour changes already placed. Usage: node make_release_3mf.mjs <release dir>
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { project3mf, stlToMesh, cornerEars } from './threemf.js';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node make_release_3mf.mjs <release dir>');
const settings = JSON.parse(readFileSync(new URL('./bambu_settings.json', import.meta.url), 'utf8'));
const part = (...p) => ({ name: p.at(-1).replace(/\.stl$/, ''), mesh: stlToMesh(new Uint8Array(readFileSync(join(dir, ...p)))) });
const folder = (...p) => readdirSync(join(dir, ...p)).filter(f => f.endsWith('.stl')).sort().map(f => part(...p, f));

const BUTTON = { bottom_shell_layers: '3', sparse_infill_density: '20%', seam_position: 'back' };   // differs from the panel's settings
const GRID = [140, 90, 40].flatMap(cy => [40, 90, 140].map(cx => [cx, cy]));                        // nine Ø42 buttons per 180 mm plate
const buttonPlates = [[...folder('buttons_brand_logos'), ...folder('buttons')]];                    // logos in the top row
const ears = p => ({ ...p, parts: [{ name: 'Corner ears (anti-lift, snap off after printing)', mesh: cornerEars(p.mesh) }] });
const base = ears(part('stand', '1_base__one_colour.stl')), panel = ears(part('stand', '2_panel_sample__white_then_black_at_4.2mm.stl'));

for (const [file, colour] of [['TapStand_all_parts__AMS.3mf', 'colour'], ['TapStand_all_parts__no_AMS_pauses.3mf', 'pause']]) {
  const objects = [
    { ...base, plate: 0, cx: 90, cy: 90, filament: colour === 'colour' ? 2 : 1 },   // with an AMS the base prints in the dark colour
    { ...panel, plate: 1, cx: 90, cy: 90 },
  ];
  const plates = [{ events: [] }, { events: [{ z: 4.2, kind: colour }] }];
  for (const group of buttonPlates) {
    if (group.length > GRID.length) throw new Error(`${group.length} buttons do not fit on one plate`);
    group.forEach((b, i) => objects.push({ ...b, plate: plates.length, cx: GRID[i][0], cy: GRID[i][1], settings: BUTTON }));
    plates.push({ events: [{ z: 3.6, kind: 'pause' }, { z: 5.2, kind: colour }] });
  }
  writeFileSync(join(dir, file), project3mf({ settings, objects, plates, deflate: deflateRawSync }));
  console.log(`wrote ${file}: ${plates.length} plates, ${objects.length} parts`);
}
