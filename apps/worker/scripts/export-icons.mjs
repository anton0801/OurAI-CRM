// Programmatic PNG exports of the vector mark (V04–V06). Not generated artwork: a rasterised SVG on the surface colour.
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
const svg = readFileSync(new URL('../../web/public/brand/castlane-mark.svg', import.meta.url));
for (const [name, size] of [['apple-touch-icon.png', 180], ['app-icon-192.png', 192], ['app-icon-512.png', 512]]) {
  const inner = Math.round(size * 0.7);
  const mark = await sharp(svg, { density: 1024 }).resize(inner, inner).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: '#FFFFFF' } })
    .composite([{ input: mark, gravity: 'centre' }])
    .flatten({ background: '#FFFFFF' })
    .png()
    .toFile(new URL(`../../web/public/${name}`, import.meta.url).pathname);
  console.log('wrote', name);
}
