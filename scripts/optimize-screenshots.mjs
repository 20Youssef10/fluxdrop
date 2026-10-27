// Optimize PWA screenshot captures down to manifest-friendly sizes.
// Narrow: 1080x1920 -> keep, wide: 1920x1080 -> keep; recompress to webp-quality PNG weight.
import sharp from 'sharp'
import { writeFile } from 'node:fs/promises'

const jobs = [
  { in: '/tmp/pwa-narrow.png', out: 'public/screenshots/narrow.png', w: 1080, h: 1920 },
  { in: '/tmp/pwa-wide.png', out: 'public/screenshots/wide.png', w: 1920, h: 1080 },
]

for (const j of jobs) {
  const buf = await sharp(j.in)
    .resize(j.w, j.h, { fit: 'cover', position: 'top' })
    .png({ quality: 80, compressionLevel: 9, palette: false })
    .toBuffer()
  await writeFile(j.out, buf)
  console.log(`${j.out}: ${(buf.length / 1024).toFixed(0)} KB`)
}
