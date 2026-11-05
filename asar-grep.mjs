/** 在 app.asar 里按子串搜文件（复用用户 asar 工具的解析逻辑）。用法: node asar-grep.mjs 词1 词2 */
import { openSync, readSync, closeSync } from 'node:fs'

const ASAR = 'E:/DeepSeek/resources/app.asar'
const needles = process.argv.slice(2)
const fd = openSync(ASAR, 'r')
const head = Buffer.alloc(16)
readSync(fd, head, 0, 16, 0)
const headerSize = head.readUInt32LE(12)
const jb = Buffer.alloc(headerSize)
readSync(fd, jb, 0, headerSize, 16)
const header = JSON.parse(jb.toString('utf8'))
const base = 16 + headerSize

const files = new Map()
const walk = (node, prefix) => {
  for (const [k, v] of Object.entries(node)) {
    const p = prefix + k
    if (v.files !== undefined) walk(v.files, p + '/')
    else files.set(p, v)
  }
}
walk(header.files, '')

const hits = []
for (const [p, e] of files) {
  if (!/\.(js|mjs|cjs|json)$/.test(p)) continue
  if (!Number.isFinite(e.size) || e.size > 4_000_000) continue
  const off = Number(e.offset)
  if (!Number.isFinite(off)) continue
  const buf = Buffer.alloc(e.size)
  readSync(fd, buf, 0, e.size, base + off)
  const s = buf.toString('utf8')
  const found = needles.filter((n) => s.includes(n))
  if (found.length > 0) hits.push({ p, size: e.size, found })
}
closeSync(fd)
console.log('HITS:', hits.length)
for (const h of hits) console.log(h.size, h.found.join(','), h.p)
