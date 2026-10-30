// One-off generator: FluxDrop NATIVE SHELL icons (Tauri desktop set) from the
// same brand bolt as the PWA icons (gen-icons.mjs) — visual continuity.
// Run: bun scripts/gen-shell-icons.mjs
//
// Produces src-tauri/icons/:
//   32x32.png, 128x128.png, 128x128@2x.png (256), icon.png (512),
//   icon.ico   — PNG-embedded entries (valid on Windows Vista+)
//   icon.icns  — PNG-payload chunks ic07/ic08/ic09 (modern macOS)
//   icon.svg   — vector source for `bunx @tauri-apps/cli icon` re-generation
import sharp from 'sharp'
import { mkdir, writeFile } from 'node:fs/promises'

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

/** Standard icon: rounded square + centered bolt (same recipe as the PWA set). */
function standardIcon(size, rx) {
  const scale = size / 30
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  ${GRADIENT}
  <rect width="${size}" height="${size}" rx="${rx}" fill="url(#bg)"/>
  <g transform="translate(${(size * 5) / 100},${(size * 5) / 100}) scale(${(scale * 90) / 100})" fill="#ffffff">${BOLT}</g>
</svg>`
}

/** ICO container with PNG payloads (Windows Vista+ accepts PNG entries). */
function ico(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)
  let offset = 6 + 16 * entries.length
  const dirs = entries.map((e) => {
    const d = Buffer.alloc(16)
    d.writeUInt8(e.size >= 256 ? 0 : e.size, 0)
    d.writeUInt8(e.size >= 256 ? 0 : e.size, 1)
    d.writeUInt16LE(1, 4) // color planes
    d.writeUInt16LE(32, 6) // bits per pixel
    d.writeUInt32LE(e.data.length, 8)
    d.writeUInt32LE(offset, 12)
    offset += e.data.length
    return d
  })
  return Buffer.concat([header, ...dirs, ...entries.map((e) => e.data)])
}

/** ICNS container with PNG payloads (ic07=128, ic08=256, ic09=512). */
function icns(chunks) {
  let total = 8
  for (const c of chunks) total += 8 + c.data.length
  const header = Buffer.alloc(8)
  header.write('icns', 0, 'ascii')
  header.writeUInt32BE(total, 4)
  const parts = []
  for (const c of chunks) {
    const h = Buffer.alloc(8)
    h.write(c.type, 0, 'ascii')
    h.writeUInt32BE(8 + c.data.length, 4)
    parts.push(h, c.data)
  }
  return Buffer.concat([header, ...parts])
}

const out = 'src-tauri/icons'
await mkdir(out, { recursive: true })

async function png(size, rx, name) {
  const data = await sharp(Buffer.from(standardIcon(size, rx))).png().toBuffer()
  await writeFile(`${out}/${name}`, data)
  console.log('wrote', `${out}/${name}`)
  return { size, data }
}

const p32 = await png(32, 7, '32x32.png')
const p128 = await png(128, 29, '128x128.png')
const p256 = await png(256, 58, '128x128@2x.png')
const p512 = await png(512, 116, 'icon.png')

await writeFile(`${out}/icon.ico`, ico([p256, p128, p32]))
console.log('wrote', `${out}/icon.ico`)
await writeFile(
  `${out}/icon.icns`,
  icns([
    { type: 'ic07', data: p128.data },
    { type: 'ic08', data: p256.data },
    { type: 'ic09', data: p512.data },
  ])
)
console.log('wrote', `${out}/icon.icns`)

// Vector source — re-generate the full platform set any time with:
//   bunx @tauri-apps/cli icon src-tauri/icons/icon.svg
await writeFile(`${out}/icon.svg`, standardIcon(512, 116))
console.log('wrote', `${out}/icon.svg`)
