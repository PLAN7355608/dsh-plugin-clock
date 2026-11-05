/** v2 实机探针：数「Clock 短消息」与「runtime-context 快照」，确认去重与体积。 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const SESSIONS = 'C:\\Users\\Administrator\\.dsh\\sessions\\--E-bigbluefishWorkbench--'

function newestSession() {
  let best = null
  for (const dir of readdirSync(SESSIONS)) {
    const file = join(SESSIONS, dir, 'session.v4.jsonl.zstd')
    try {
      const m = statSync(file).mtimeMs
      if (best === null || m > best.m) best = { file, m, dir }
    } catch {}
  }
  return best
}

function events(file) {
  const buf = readFileSync(file)
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const cuts = []
  for (let i = 0; i + 4 <= buf.length; i++) if (buf.compare(MAGIC, 0, 4, i, i + 4) === 0) cuts.push(i)
  const chunks = []
  let i = 0
  while (i < cuts.length) {
    let j = i + 1
    for (;;) {
      const end = j < cuts.length ? cuts[j] : buf.length
      try {
        chunks.push(zstdDecompressSync(buf.subarray(cuts[i], end)))
        break
      } catch {
        j++
        if (j > cuts.length) break
      }
    }
    i = Math.max(j, i + 1)
  }
  const out = []
  for (const line of Buffer.concat(chunks).toString('utf8').split('\n')) {
    if (line.length === 0) continue
    try { out.push(JSON.parse(line)) } catch {}
  }
  return out
}

const session = newestSession()
console.log('会话:', session.dir, '| 事件数:', events(session.file).length)
const evs = events(session.file)

const clockRe = /Clock: (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) \w{3} · ([^(]+)\(UTC([+-]\d{2}:\d{2})\)/
const clocks = []
const snaps = []
const builtin = []
for (const ev of evs) {
  if (ev.type !== 'user/message') continue
  const src = ev.data?.source ?? {}
  const text = ev.data?.content?.[0]?.text ?? ''
  if (src.kind === 'clock') clocks.push({ at: ev.ts ?? ev.time ?? ev.at ?? '?', text })
  else if (src.kind === 'time-context') builtin.push(text)
  else if (src.kind === 'runtime-context') snaps.push(text)
}

console.log('')
console.log('=== 内置 time-context（应被 0.1.2 挡掉）===')
console.log('条数:', builtin.length)
for (const text of builtin.slice(-2)) console.log('  -', text.split('\n')[0])

console.log('')
console.log('=== 通道 B：Clock 短消息 ===')
console.log('条数:', clocks.length)
const minutes = clocks.map((c) => (clockRe.exec(c.text) ?? [])[1]).filter(Boolean)
console.log('不同分钟:', new Set(minutes).size, '| 有重复分钟:', new Set(minutes).size !== minutes.length)
console.log('字符数:', clocks.length > 0 ? clocks[0].text.length : 0, '| 前两条:')
for (const c of clocks.slice(0, 2)) console.log('  -', c.text)
console.log('后两条:')
for (const c of clocks.slice(-2)) console.log('  -', c.text)

console.log('')
console.log('=== 通道 A：runtime-context 快照 ===')
console.log('条数:', snaps.length)
for (const [idx, text] of snaps.entries()) {
  const hasCalendar = text.includes('Calendar:')
  const sections = /Calendar: (\d{4}-\d{2}-\d{2} [A-Za-z]+)/.exec(text)?.[1] ?? ''
  console.log(`#${idx + 1} 长度 ${text.length} 字符 | Calendar=${hasCalendar ? sections : '无'}`)
}
const withCal = snaps.filter((t) => t.includes('Calendar:')).length
console.log('含 Calendar 的快照:', withCal, '| 不同日期数:', new Set(snaps.map((t) => /Calendar: (\d{4}-\d{2}-\d{2})/.exec(t)?.[1]).filter(Boolean)).size)
