/**
 * Derives every icon whisp ships from one high-resolution RGBA master:
 * resources/logo.png. Run with: npm run gen:icons. Outputs:
 *
 *   resources/tray-idle.png       32px, the mark
 *   resources/tray-recording.png  32px, the mark + red badge (bottom-right)
 *   resources/tray-muted.png      32px, the mark at 35% opacity
 *   resources/whisp.ico           256/64/48/32/16 PNG entries — installer,
 *                                 shortcut, window icon
 *
 * Everything is derived, nothing hand-edited: swap logo.png, rerun, done.
 * The mark is cropped to its alpha bounding box (+8% pad) before scaling —
 * the generous margin that suits a large icon wastes pixels at 16px.
 *
 * Self-contained on purpose (PNG codec included): no sharp, no GDI, no
 * native deps — the same reason the app itself only depends on koffi.
 */
const { deflateSync, inflateSync } = require('node:zlib')
const { readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

/* PNG codec ---------------------------------------------------------- */

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

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Decodes the one shape this pipeline needs: 8-bit RGBA, non-interlaced. */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let width = 0
  let height = 0
  const idat = []
  let pos = 8
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) {
        throw new Error('expected 8-bit RGBA non-interlaced PNG (re-export logo.png that way)')
      }
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const rgba = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? rgba[y * stride + x - 4] : 0
      const up = y > 0 ? rgba[(y - 1) * stride + x] : 0
      const upLeft = x >= 4 && y > 0 ? rgba[(y - 1) * stride + x - 4] : 0
      let v = row[x]
      if (filter === 1) v += left
      else if (filter === 2) v += up
      else if (filter === 3) v += (left + up) >> 1
      else if (filter === 4) v += paeth(left, up, upLeft)
      rgba[y * stride + x] = v & 0xff
    }
  }
  return { width, height, rgba }
}

/* Image ops ------------------------------------------------------------ */

/**
 * Box-filter resize on premultiplied alpha — the correct way to shrink art
 * with soft glows: every source pixel contributes by its coverage, and color
 * never bleeds in from fully transparent neighbors.
 */
function resize(img, dw, dh) {
  const { width: sw, height: sh, rgba: src } = img
  const dst = Buffer.alloc(dw * dh * 4)
  const xr = sw / dw
  const yr = sh / dh
  for (let dy = 0; dy < dh; dy++) {
    const y0 = dy * yr
    const y1 = (dy + 1) * yr
    for (let dx = 0; dx < dw; dx++) {
      const x0 = dx * xr
      const x1 = (dx + 1) * xr
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let w = 0
      for (let sy = Math.floor(y0); sy < Math.min(Math.ceil(y1), sh); sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0)
        for (let sx = Math.floor(x0); sx < Math.min(Math.ceil(x1), sw); sx++) {
          const wx = Math.min(sx + 1, x1) - Math.max(sx, x0)
          const wt = wx * wy
          const i = (sy * sw + sx) * 4
          const alpha = src[i + 3] / 255
          r += src[i] * alpha * wt
          g += src[i + 1] * alpha * wt
          b += src[i + 2] * alpha * wt
          a += alpha * wt
          w += wt
        }
      }
      const i = (dy * dw + dx) * 4
      if (a > 0) {
        dst[i] = Math.round(r / a)
        dst[i + 1] = Math.round(g / a)
        dst[i + 2] = Math.round(b / a)
      }
      dst[i + 3] = Math.round((255 * a) / w)
    }
  }
  return { width: dw, height: dh, rgba: dst }
}

/** Crops to the alpha bounding box, squared and padded — the icon master. */
function cropToContent(img, padFraction) {
  const { width, height, rgba } = img
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) throw new Error('logo.png is fully transparent')
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const span = Math.max(maxX - minX, maxY - minY) + 1
  const side = Math.round(span * (1 + padFraction * 2))
  const x0 = Math.round(cx - side / 2)
  const y0 = Math.round(cy - side / 2)
  const out = Buffer.alloc(side * side * 4)
  for (let y = 0; y < side; y++) {
    const sy = y0 + y
    if (sy < 0 || sy >= height) continue
    for (let x = 0; x < side; x++) {
      const sx = x0 + x
      if (sx < 0 || sx >= width) continue
      rgba.copy(out, (y * side + x) * 4, (sy * width + sx) * 4, (sy * width + sx) * 4 + 4)
    }
  }
  return { width: side, height: side, rgba: out }
}

/** Alpha-composites an antialiased disc over the image (the recording badge). */
function drawDisc(img, cx, cy, radius, [r, g, b], alpha) {
  const { width, height, rgba } = img
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const coverage = Math.max(0, Math.min(1, radius - Math.hypot(x - cx, y - cy) + 0.5)) * alpha
      if (coverage <= 0) continue
      const i = (y * width + x) * 4
      const srcA = coverage
      const dstA = rgba[i + 3] / 255
      const outA = srcA + dstA * (1 - srcA)
      rgba[i] = Math.round((r * srcA + rgba[i] * dstA * (1 - srcA)) / outA)
      rgba[i + 1] = Math.round((g * srcA + rgba[i + 1] * dstA * (1 - srcA)) / outA)
      rgba[i + 2] = Math.round((b * srcA + rgba[i + 2] * dstA * (1 - srcA)) / outA)
      rgba[i + 3] = Math.round(outA * 255)
    }
  }
}

function fadeAlpha(img, factor) {
  const out = Buffer.from(img.rgba)
  for (let i = 3; i < out.length; i += 4) out[i] = Math.round(out[i] * factor)
  return { width: img.width, height: img.height, rgba: out }
}

/* ICO assembly ----------------------------------------------------------- */

/**
 * A classic BMP icon entry: BITMAPINFOHEADER + bottom-up BGRA + an all-zero
 * AND mask (the 32-bit alpha channel is the real mask). PNG entries are only
 * safe at 256 — GDI+ and other legacy consumers render PNG-compressed small
 * sizes as noise, so those stay BMP, the canonical layout.
 */
function bmpEntry(size, rgba) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0) // biSize
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8) // height counts XOR + AND masks
  header.writeUInt16LE(1, 12) // planes
  header.writeUInt16LE(32, 14) // bit depth
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size // bottom-up
    for (let x = 0; x < size; x++) {
      const s = (srcRow + x) * 4
      const d = (y * size + x) * 4
      pixels[d] = rgba[s + 2] // B
      pixels[d + 1] = rgba[s + 1] // G
      pixels[d + 2] = rgba[s] // R
      pixels[d + 3] = rgba[s + 3] // A
    }
  }
  const andMask = Buffer.alloc(Math.ceil(size / 32) * 4 * size)
  return Buffer.concat([header, pixels, andMask])
}

function encodeIco(entriesBySize) {
  const entries = Object.entries(entriesBySize).map(([size, data]) => ({ size: Number(size), data }))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)
  const dir = Buffer.alloc(16 * entries.length)
  let offset = 6 + dir.length
  entries.forEach((entry, i) => {
    dir[i * 16] = entry.size >= 256 ? 0 : entry.size // width (0 = 256)
    dir[i * 16 + 1] = entry.size >= 256 ? 0 : entry.size // height
    dir.writeUInt16LE(1, i * 16 + 4) // planes
    dir.writeUInt16LE(32, i * 16 + 6) // bit depth
    dir.writeUInt32LE(entry.data.length, i * 16 + 8)
    dir.writeUInt32LE(offset, i * 16 + 12)
    offset += entry.data.length
  })
  return Buffer.concat([header, dir, ...entries.map((e) => e.data)])
}

/* Pipeline ------------------------------------------------------------------ */

const resources = join(__dirname, '..', 'resources')
const logo = decodePng(readFileSync(join(resources, 'logo.png')))
const mark = cropToContent(logo, 0.08)

// Tray: 32px states. Recording gets a red badge bottom-right, with a darker
// rim underneath to separate it from the mark at a glance.
const TRAY = 32
const idle = resize(mark, TRAY, TRAY)

const recording = { width: TRAY, height: TRAY, rgba: Buffer.from(idle.rgba) }
drawDisc(recording, 23.5, 23.5, 9.5, [0x16, 0x13, 0x10], 1)
drawDisc(recording, 23.5, 23.5, 8, [0xe1, 0x4a, 0x3c], 1)

const muted = fadeAlpha(idle, 0.35)

// A small mark for the settings UI — the 1.4MB master has no business
// being bundled into the renderer for a 28px sidebar image.
const uiMark = resize(mark, 128, 128)
writeFileSync(join(resources, 'logo-128.png'), encodePng(128, 128, uiMark.rgba))
console.log('wrote resources/logo-128.png')

writeFileSync(join(resources, 'tray-idle.png'), encodePng(TRAY, TRAY, idle.rgba))
writeFileSync(join(resources, 'tray-recording.png'), encodePng(TRAY, TRAY, recording.rgba))
writeFileSync(join(resources, 'tray-muted.png'), encodePng(TRAY, TRAY, muted.rgba))
console.log('wrote resources/tray-{idle,recording,muted}.png')

// The .ico: every size Windows actually asks for, all from the same master.
const icoSizes = [256, 64, 48, 32, 16]
const ico = {}
for (const size of icoSizes) {
  const scaled = resize(mark, size, size)
  ico[size] = size >= 256 ? encodePng(size, size, scaled.rgba) : bmpEntry(size, scaled.rgba)
}
writeFileSync(join(resources, 'whisp.ico'), encodeIco(ico))
console.log('wrote resources/whisp.ico (' + icoSizes.join(', ') + ')')
