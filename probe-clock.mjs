import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
const buf = readFileSync(file)

// 文件是多帧 zstd 拼接：按 magic(28 B5 2F FD) 切分，逐帧解压。
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const cuts = []
for (let i = 0; i + 4 <= buf.length; i++) if (buf.compare(MAGIC, 0, 4, i, i + 4) === 0) cuts.push(i)

let text = ''
let bad = 0
let i = 0
while (i < cuts.length) {
  let j = i + 1
  for (;;) {
    const end = j < cuts.length ? cuts[j] : buf.length
    try {
      text += zstdDecompressSync(buf.subarray(cuts[i], end)).toString('utf8')
      break
    } catch {
      j++
      if (j > cuts.length) { bad++; break }
    }
  }
  i = Math.max(j, i + 1)
}

const lines = text.split('\n').filter((l) => l.length > 0)
console.log('帧数:', cuts.length, '解压失败段:', bad, '事件行:', lines.length)

const clockRe = /Clock: (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/
const stamps = []
let snaps = 0
for (const line of lines) {
  let ev
  try { ev = JSON.parse(line) } catch { continue }
  if (ev.type !== 'user/message' || ev.data?.source?.kind !== 'runtime-context') continue
  snaps++
  const body = ev.data.content?.[0]?.text ?? ''
  for (const seg of body.split(/\n(?=Clock: )/)) {
    const m = clockRe.exec(seg)
    if (m !== null) stamps.push(m[1])
  }
}
console.log('runtime-context 快照总数:', snaps)
console.log('其中含 Clock 行:', stamps.length)
console.log('不同分钟数:', new Set(stamps).size)
console.log('前 8 条:', stamps.slice(0, 8).join(' | '))
console.log('后 8 条:', stamps.slice(-8).join(' | '))
