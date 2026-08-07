/**
 * Generates whisp's placeholder tray icons — antialiased dots on transparent
 * 32px canvases, encoded as PNG by hand so there is nothing to install. Run
 * with: npm run gen:icons. Replace resources/*.png with real art whenever it
 * exists; this script just guarantees the tray never ships iconless.
 */
const { deflateSync } = require('node:zlib')
const { writeFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  // Raw scanlines, filter byte 0 per row.
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** An antialiased disc: coverage from distance to the rim, times the tint. */
function disc(size, [r, g, b], alpha) {
  const rgba = Buffer.alloc(size * size * 4)
  const center = (size - 1) / 2
  const radius = size * 0.34
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - center, y - center)
      const coverage = Math.max(0, Math.min(1, radius - d + 0.5))
      const i = (y * size + x) * 4
      rgba[i] = r
      rgba[i + 1] = g
      rgba[i + 2] = b
      rgba[i + 3] = Math.round(coverage * alpha * 255)
    }
  }
  return rgba
}

const SIZE = 32
const outDir = join(__dirname, '..', 'resources')
mkdirSync(outDir, { recursive: true })

const icons = {
  // Idle: the pill's warm off-white. Recording: its red. Muted: idle at 35% —
  // present, deliberately not listening.
  'tray-idle.png': disc(SIZE, [0xcf, 0xc8, 0xbd], 1),
  'tray-recording.png': disc(SIZE, [0xe1, 0x4a, 0x3c], 1),
  'tray-muted.png': disc(SIZE, [0xcf, 0xc8, 0xbd], 0.35)
}

for (const [name, rgba] of Object.entries(icons)) {
  writeFileSync(join(outDir, name), encodePng(SIZE, rgba))
  console.log('wrote', join('resources', name))
}
