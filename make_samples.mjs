// Writes the blank panel for the release. Usage: node make_samples.mjs <output dir>
// (The example panel with the starter logo is made with the page, because tracing an SVG needs a browser;
// it is kept as stand/3_panel_template_logo__… in the project.)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { init, buildPanel } from './core.js';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node make_samples.mjs <output dir>');
writeFileSync(join(dir, '2_panel_blank__one_colour.stl'), buildPanel(await init()).stl);
console.log('wrote the blank panel to', dir);
