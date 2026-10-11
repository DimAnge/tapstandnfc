// Writes the blank and sample panels for the release. Usage: node make_samples.mjs <output dir>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseFont } from './vendor/opentype.module.js';
import { init, buildPanel } from './core.js';
import { textRings, place } from './shapes.js';

const dir = process.argv[2];
if (!dir) throw new Error('usage: node make_samples.mjs <output dir>');
const wasm = await init();
const bytes = readFileSync(new URL('./vendor/fonts/Poppins-Bold.ttf', import.meta.url));
const font = parseFont(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const line = (text, cap, cy) => ({ rings: place(textRings(font, text, cap), { maxWidth: 150, cx: 0, cy, flipY: true }).rings, fillRule: 'NonZero' });

writeFileSync(join(dir, '2_panel_blank__one_colour.stl'), buildPanel(wasm).stl);
const sample = buildPanel(wasm, [line('YOUR LOGO', 18, 58), line('@yourhandle', 6, 18)]);
if (sample.warnings.length) throw new Error('sample panel has warnings: ' + JSON.stringify(sample.warnings));
writeFileSync(join(dir, '2_panel_sample__white_then_black_at_4.2mm.stl'), sample.stl);
console.log('wrote panels to', dir);
