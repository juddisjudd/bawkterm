// Builds the app icons from src/renderer/src/assets/chicken.svg (one black path on transparent).
// Writes build/icon.{svg,png,ico} (white rooster on a dark tile, the exe default) and
// build/icon-light.{png,ico} (black rooster on a light tile, swapped in at runtime in light mode).
// Usage: pnpm icon [previewDir]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'

const root = join(import.meta.dirname, '..')
const source = readFileSync(join(root, 'src/renderer/src/assets/chicken.svg'), 'utf8')
const path = source.match(/<path[^>]*\sd="([^"]+)"/)?.[1]
if (!path) throw new Error('chicken.svg must contain one <path d="…">')

const VIEW = 512
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const VARIANTS = {
  dark: { tile: '#141010', border: '#2e2727', ink: '#f2eded' },
  light: { tile: '#fdfcfc', border: '#dcd6d6', ink: '#141010' }
}

const box = new Resvg(source).getBBox()

function svg(pixels, variant) {
  const { tile, border, ink } = VARIANTS[variant]
  // small sizes get less padding and a hairline stroke so the outline survives downscaling
  const fill = pixels <= 24 ? 0.84 : pixels <= 48 ? 0.8 : 0.74
  const scale = (VIEW * fill) / Math.max(box.width, box.height)
  const tx = (VIEW - box.width * scale) / 2 - box.x * scale
  const ty = (VIEW - box.height * scale) / 2 - box.y * scale
  const unitsPerPixel = VIEW / pixels / scale
  const thicken = pixels <= 32 ? 0.35 * unitsPerPixel : 0
  const radius = pixels <= 32 ? VIEW * 0.2 : VIEW * 0.22
  const edge = pixels <= 32 ? 0 : Math.max(1, VIEW / pixels)
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW} ${VIEW}" width="${pixels}" height="${pixels}">`,
    `<rect x="${edge / 2}" y="${edge / 2}" width="${VIEW - edge}" height="${VIEW - edge}" rx="${radius}" fill="${tile}"${edge ? ` stroke="${border}" stroke-width="${edge}"` : ''}/>`,
    `<path transform="translate(${tx.toFixed(2)} ${ty.toFixed(2)}) scale(${scale.toFixed(5)})" d="${path}" fill="${ink}"${thicken ? ` stroke="${ink}" stroke-width="${thicken.toFixed(2)}" stroke-linejoin="round"` : ''}/>`,
    '</svg>'
  ].join('')
}

function png(pixels, variant) {
  return new Resvg(svg(pixels, variant), { fitTo: { mode: 'width', value: pixels } }).render().asPng()
}

function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(({ size, data }, i) => {
    const at = 6 + i * 16
    header.writeUInt8(size >= 256 ? 0 : size, at)
    header.writeUInt8(size >= 256 ? 0 : size, at + 1)
    header.writeUInt16LE(1, at + 4)
    header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(data.length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += data.length
  })
  return Buffer.concat([header, ...images.map((img) => img.data)])
}

const out = join(root, 'build')
const preview = process.argv[2]
mkdirSync(out, { recursive: true })
if (preview) mkdirSync(preview, { recursive: true })

for (const variant of ['dark', 'light']) {
  const name = variant === 'dark' ? 'icon' : 'icon-light'
  if (variant === 'dark') writeFileSync(join(out, 'icon.svg'), svg(512, variant))
  writeFileSync(join(out, `${name}.png`), png(512, variant))
  const images = SIZES.map((size) => ({ size, data: png(size, variant) }))
  writeFileSync(join(out, `${name}.ico`), ico(images))
  if (preview) for (const { size, data } of images) writeFileSync(join(preview, `${name}-${size}.png`), data)
}
console.log(`wrote build/icon.{svg,png,ico} and build/icon-light.{png,ico} (${SIZES.join(', ')} px)`)
