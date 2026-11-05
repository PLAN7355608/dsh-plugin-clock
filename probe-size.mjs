import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
const buf = readFileSync(process.argv[2])
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const cuts = []
for (let i = 0; i + 4 <= buf.length; i++) if (buf.compare(MAGIC, 0, 4, i, i + 4) === 0) cuts.push(i)
let text = ''
for (let i = 0, j; i < cuts.length; i = Math.max(j, i + 1)) {
  j = i + 1
  for (;;) {
    try { text += zstdDecompressSync(buf.subarray(cuts[i], j < cuts.length ? cuts[j] : buf.length)).toString('utf8'); break } catch { if (++j > cuts.length) break }
  }
}
for (const line of text.split('\n')) {
  if (!line) continue
  let ev; try { ev = JSON.parse(line) } catch { continue }
  if (ev.type !== 'user/message' || ev.data?.source?.kind !== 'runtime-context') continue
  const body = ev.data.content?.[0]?.text ?? ''
  const secs = (ev.data.source.sections ?? []).map((s) => s.name)
  console.log(`--- seq=${ev.seq} chars=${body.length} est.tokens=${Math.round(body.length / 3.2)} sections=[${secs.join(', ')}]`)
  console.log(`    首行: ${body.split('\n')[0].slice(0, 80)}`)
}
