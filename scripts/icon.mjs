// Draws the bawkterm chicken and writes build/icon.{svg,png,ico}.
// 64px and up: isometric line art. Below that the lines blur, so hand-placed pixel art is used instead.
// Usage: pnpm icon [previewDir]
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'

const BG = '#141010'
const EDGE = '#f2eded'
const SHADE = { top: '#2b2424', left: '#141010', right: '#1d1818' }
const PIXEL = { '#': EDGE, '+': '#8f8787', o: BG }
const VIEW = 64
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]

// u: toward the chicken's front (screen lower-left), v: its right side (screen lower-right), z: up
const box = (u0, u1, v0, v1, z0, z1) => ({ kind: 'box', u: [u0, u1], v: [v0, v1], z: [z0, z1] })
// side profile in (u, z), counter-clockwise, extruded across v
const prism = (profile, v0, v1) => ({ kind: 'prism', profile, v: [v0, v1] })

const chicken = [
  box(1.5, 1.85, 0.6, 0.95, 0, 1.5),
  box(1.5, 2.5, 0.6, 0.95, 0, 0.3),
  box(1.5, 1.85, 1.55, 1.9, 0, 1.5),
  box(1.5, 2.5, 1.55, 1.9, 0, 0.3),
  prism([[0.7, 1.4], [2.7, 1.4], [3.4, 2.2], [3.4, 3.7], [1.4, 3.7], [0.5, 5.1], [-0.5, 4.8], [-0.4, 2.6]], 0, 2.5),
  box(0.9, 2.6, 2.5, 2.9, 2.1, 3.25),
  box(2.2, 3.7, 0.45, 2.05, 3.7, 5.4),
  box(2.25, 2.6, 1.0, 1.5, 5.4, 5.95),
  box(2.6, 3.05, 1.0, 1.5, 5.4, 6.35),
  box(3.05, 3.5, 1.0, 1.5, 5.4, 6.05),
  box(3.7, 3.95, 1.05, 1.45, 3.75, 4.3),
  prism([[3.7, 4.3], [4.75, 4.62], [3.7, 4.95]], 0.95, 1.55)
]
const EYE = { u: 3.2, v: 2.05, z: 4.85, size: 1.1 }

const SPRITES = {
  16: [
    '................',
    '....#.#.........',
    '...#####....#...',
    '...#####...##...',
    '...#o###..###...',
    '.#######.####...',
    '..###########...',
    '...##########...',
    '...###++++###...',
    '...####++####...',
    '....#########...',
    '.....#######....',
    '......#..#......',
    '.....##.##......',
    '................',
    '................'
  ],
  24: [
    '........................',
    '........................',
    '.......##...............',
    '.....#.##.#.............',
    '.....######.......#.....',
    '....########.....###....',
    '....########....####....',
    '....#o######...#####....',
    '..###o######..######....',
    '.####################...',
    '...##################...',
    '....#################...',
    '....#################...',
    '....#####+++++++#####...',
    '....######+++++######...',
    '.....###############....',
    '......#############.....',
    '........#########.......',
    '.........#...#..........',
    '.........#...#..........',
    '........##..##..........',
    '........................',
    '........................',
    '........................'
  ]
}
// size: [sprite grid, padding in px, pixels per cell]
const SPRITE_FOR = { 16: [16, 0, 1], 20: [16, 2, 1], 24: [24, 0, 1], 32: [24, 4, 1], 40: [16, 4, 2], 48: [24, 0, 2] }

const C = Math.cos(Math.PI / 6)
const project = (u, v, z) => [(v - u) * C, (u + v) * 0.5 - z]

function faces(part) {
  const [v0, v1] = part.v
  if (part.kind === 'prism') {
    const p = part.profile
    const sides = p
      .map((a, i) => {
        const b = p[(i + 1) % p.length]
        const [nu, nz] = [b[1] - a[1], a[0] - b[0]]
        if (nu + nz <= 1e-9) return null
        return {
          depth: (a[0] + b[0] + a[1] + b[1]) / 2,
          shade: nz > nu ? 'top' : 'left',
          pts: [[a[0], v0, a[1]], [b[0], v0, b[1]], [b[0], v1, b[1]], [a[0], v1, a[1]]]
        }
      })
      .filter(Boolean)
      .sort((x, y) => x.depth - y.depth)
    return [...sides, { shade: 'right', pts: p.map(([u, z]) => [u, v1, z]) }]
  }
  const [u0, u1] = part.u
  const [z0, z1] = part.z
  return [
    { shade: 'top', pts: [[u0, v0, z1], [u1, v0, z1], [u1, v1, z1], [u0, v1, z1]] },
    { shade: 'left', pts: [[u1, v0, z0], [u1, v1, z0], [u1, v1, z1], [u1, v0, z1]] },
    { shade: 'right', pts: [[u0, v1, z0], [u1, v1, z0], [u1, v1, z1], [u0, v1, z1]] }
  ]
}

function layout(fill) {
  const all = chicken.flatMap(faces).flatMap((f) => f.pts.map((p) => project(...p)))
  const xs = all.map((p) => p[0])
  const ys = all.map((p) => p[1])
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const scale = (VIEW * fill) / Math.max(maxX - minX, maxY - minY)
  const ox = (VIEW - (maxX - minX) * scale) / 2 - minX * scale
  const oy = (VIEW - (maxY - minY) * scale) / 2 - minY * scale
  return (u, v, z) => {
    const [x, y] = project(u, v, z)
    return [+(x * scale + ox).toFixed(2), +(y * scale + oy).toFixed(2)]
  }
}

function lineArt(pixels) {
  const at = layout(0.72)
  const px = (n) => +(n * (VIEW / pixels)).toFixed(3)
  const edge = px(Math.max(1.6, pixels * 0.017))
  const polygons = chicken
    .flatMap(faces)
    .map((f) => `<polygon points="${f.pts.map((q) => at(...q).join(',')).join(' ')}" fill="${SHADE[f.shade]}"/>`)
    .join('')
  const [ex, ey] = at(EYE.u, EYE.v, EYE.z)
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW} ${VIEW}" width="${pixels}" height="${pixels}">`,
    `<rect x="0.5" y="0.5" width="${VIEW - 1}" height="${VIEW - 1}" rx="14" fill="${BG}" stroke="#2e2727" stroke-width="${px(1)}"/>`,
    `<g stroke="${EDGE}" stroke-width="${edge}" stroke-linejoin="round" stroke-linecap="round">${polygons}</g>`,
    `<rect x="${ex - EYE.size / 2}" y="${ey - EYE.size / 2}" width="${EYE.size}" height="${EYE.size}" fill="${EDGE}"/>`,
    '</svg>'
  ].join('')
}

function pixelArt(pixels) {
  const [grid, pad, k] = SPRITE_FOR[pixels]
  const rows = SPRITES[grid]
  const cells = rows.flatMap((row, y) =>
    [...row].map((ch, x) => (PIXEL[ch] ? `<rect x="${pad + x * k}" y="${pad + y * k}" width="${k}" height="${k}" fill="${PIXEL[ch]}"/>` : ''))
  )
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${pixels} ${pixels}" width="${pixels}" height="${pixels}">`,
    `<rect width="${pixels}" height="${pixels}" rx="${pixels * 0.2}" fill="${BG}"/>`,
    `<g shape-rendering="crispEdges">${cells.join('')}</g>`,
    '</svg>'
  ].join('')
}

const svg = (pixels) => (SPRITE_FOR[pixels] ? pixelArt(pixels) : lineArt(pixels))

function png(pixels) {
  return new Resvg(svg(pixels), { fitTo: { mode: 'width', value: pixels } }).render().asPng()
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

const out = join(import.meta.dirname, '..', 'build')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'icon.svg'), lineArt(512))
writeFileSync(join(out, 'icon.png'), png(512))
const images = ICO_SIZES.map((size) => ({ size, data: png(size) }))
writeFileSync(join(out, 'icon.ico'), ico(images))

const preview = process.argv[2]
if (preview) {
  mkdirSync(preview, { recursive: true })
  for (const { size, data } of images) writeFileSync(join(preview, `icon-${size}.png`), data)
}
console.log(`wrote build/icon.svg, build/icon.png and build/icon.ico (${ICO_SIZES.join(', ')} px)`)
