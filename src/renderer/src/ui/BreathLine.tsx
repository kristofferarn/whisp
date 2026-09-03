import { useEffect, useRef, type RefObject } from 'react'

/**
 * The breath line, drawn for the settings window: one thread across the
 * width, pinned at both ends like a string. At rest it barely undulates;
 * mic bands pluck it, each band driving one harmonic. The same drawing lives
 * inline in main's pill page (pill.ts), which can't import anything — keep
 * the two in step by eye when touching either.
 *
 * `bands` is a ref, not state: it changes at meter rate and must not re-render
 * anything. The canvas reads it every frame.
 */
const CYCLES = [1, 2, 3.1, 4.4, 6]
const DRIFT = [1.3, -1.9, 2.6, -3.4, 4.1]
const GAIN = [7, 5.5, 4, 2.6, 1.6]

export function BreathLine({
  bands,
  live
}: {
  bands: RefObject<number[]>
  live: boolean
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const liveRef = useRef(live)
  liveRef.current = live

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const amp = [0, 0, 0, 0, 0]
    let energy = 0
    let t = 0
    let cw = 0
    let ch = 0
    let raf = 0

    const draw = (): void => {
      raf = requestAnimationFrame(draw)
      t += 0.016
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (w !== cw || h !== ch) {
        cw = w
        ch = h
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      }
      if (cw === 0) return
      const target = liveRef.current ? bands.current ?? [] : []
      let peak = 0
      for (let k = 0; k < 5; k++) {
        const v = Math.max(0, Math.min(1, target[k] ?? 0))
        amp[k] += (v - amp[k]) * (v > amp[k] ? 0.4 : 0.07)
        peak = Math.max(peak, amp[k])
      }
      energy += (peak - energy) * (peak > energy ? 0.3 : 0.06)
      ctx.clearRect(0, 0, cw, ch)

      const mid = ch / 2
      const breath = 0.5 + 0.5 * Math.sin(t * 1.6)
      const N = Math.max(24, Math.floor(cw / 3))
      for (let pass = 0; pass < 2; pass++) {
        ctx.beginPath()
        for (let i = 0; i <= N; i++) {
          const u = i / N
          const env = Math.pow(Math.sin(Math.PI * u), 0.85)
          let y = Math.sin(u * 6.2832 + t * 1.1) * (0.45 + breath * 0.5)
          for (let k = 0; k < 5; k++) {
            y += Math.sin(u * 6.2832 * CYCLES[k] + t * DRIFT[k]) * amp[k] * GAIN[k]
          }
          const px = u * cw
          const py = mid + y * env
          if (i === 0) ctx.moveTo(px, py)
          else ctx.lineTo(px, py)
        }
        if (pass === 0) {
          ctx.lineWidth = 8
          ctx.strokeStyle = `rgba(200, 192, 255, ${0.1 + energy * 0.45})`
        } else {
          ctx.lineWidth = 1.7
          ctx.lineCap = 'round'
          ctx.strokeStyle = `rgba(255, 255, 255, ${0.75 + energy * 0.25})`
        }
        ctx.stroke()
      }
    }
    draw()
    return () => cancelAnimationFrame(raf)
  }, [bands])

  return <canvas ref={canvasRef} className="breathline" aria-hidden="true" />
}
