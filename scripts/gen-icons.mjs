// One-off generator: FluxDrop PWA icons from the brand bolt (sharp).
// Run: bun scripts/gen-icons.mjs
import sharp from 'sharp'
import { mkdir } from 'node:fs/promises'

const BOLT = `
  <path d="M15.47,7.1l-1.3,1.85c-0.2,0.29-0.54,0.47-0.9,0.47h-7.1V7.09C6.16,7.1,15.47,7.1,15.47,7.1z"/>
  <polygon points="24.3,7.1 13.14,22.91 5.7,22.91 16.86,7.1"/>
  <path d="M14.53,22.91l1.31-1.86c0.2-0.29,0.54-0.47,0.9-0.47h7.09v2.33H14.53z"/>
`

const GRADIENT = `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#12b3a0"/>
      <stop offset="0.55" stop-color="#0ea5a0"/>
      <stop offset="1" stop-color="#0c8f8a"/>
    </linearGradient>
  </defs>
`

/** Standard icon: rounded square + centered bolt. */
function standardIcon(size, rx) {
  const scale = size / 30
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  ${GRADIENT}
  <rect width="${size}" height="${size}" rx="${rx}" fill="url(#bg)"/>
  <g transform="translate(${(size * 5) / 100},${(size * 5) / 100}) scale(${(scale * 90) / 100})" fill="#ffffff">${BOLT}</g>
</svg>`
}

/** Maskable icon: full-bleed background, bolt shrunk into the 40%-radius safe zone. */
function maskableIcon(size) {
  const scale = (size / 30) * 0.62
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  ${GRADIENT}
  <rect width="${size}" height="${size}" fill="url(#bg)"/>
  <g transform="translate(${(size * 19) / 100},${(size * 19) / 100}) scale(${scale})" fill="#ffffff">${BOLT}</g>
</svg>`
}

const out = 'public/icons'
await mkdir(out, { recursive: true })

const jobs = [
  ['icon-192.png', standardIcon(192, 44)],
  ['icon-512.png', standardIcon(512, 116)],
  ['maskable-512.png', maskableIcon(512)],
  ['apple-touch-icon.png', maskableIcon(180)],
]

for (const [name, svg] of jobs) {
  await sharp(Buffer.from(svg)).png().toFile(`${out}/${name}`)
  console.log('wrote', `${out}/${name}`)
}
