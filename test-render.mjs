/** 渲染逻辑的离线自测：不碰 DSH，只验日期算术、时区与「一天/一分钟」的去重边界。 */
import { minuteKey, renderCalendar, renderClock } from './index.js'

const TZ = 'Asia/Hong_Kong'

console.log('=== L1 时刻 ===')
for (const [label, iso, tz] of [
  ['本会话取样时刻', '2026-11-01T19:09:29+08:00', TZ],
  ['月末最后一分钟', '2026-10-31T23:59:00+08:00', TZ],
  ['加德满都 +05:45', '2026-11-01T09:00:00+05:45', 'Asia/Kathmandu'],
  ['UTC', '2026-03-01T00:30:00Z', 'UTC'],
]) {
  console.log(`[${label}] ${renderClock(new Date(iso), { timeZone: tz })}`)
}

console.log('')
console.log('=== L2 日历 ===')
for (const [label, iso, tz] of [
  ['普通日', '2026-11-01T19:09:00+08:00', TZ],
  ['月末最后一小时', '2026-10-31T23:59:00+08:00', TZ],
  ['跨年', '2026-12-31T23:59:30+08:00', TZ],
  ['闰日', '2028-02-29T12:00:00+08:00', TZ],
  ['纽约夏令时结束日', '2026-11-01T23:30:00-05:00', 'America/New_York'],
  ['Kiritimati +14', '2026-11-01T00:30:00+14:00', 'Pacific/Kiritimati'],
]) {
  const text = renderCalendar(new Date(iso), { timeZone: tz })
  console.log(`### ${label}`)
  console.log(text)
  console.log('')
}

/* ---- 去重边界：这两条是成本红线，挂了就会每分钟重发 758 token ---- */
const at = (iso) => new Date(iso)
console.log('=== 去重语义 ===')
console.log(
  '同一分钟内 renderClock 不同:',
  renderClock(at('2026-11-01T19:09:01+08:00'), { timeZone: TZ }) !==
    renderClock(at('2026-11-01T19:09:59+08:00'), { timeZone: TZ }),
  '(应为 false)',
)
console.log(
  '跨分钟 minuteKey 变化:',
  minuteKey(at('2026-11-01T19:09:59+08:00'), TZ) !== minuteKey(at('2026-11-01T19:10:00+08:00'), TZ),
  '(应为 true)',
)
console.log(
  '同一天内 renderCalendar 恒定:',
  renderCalendar(at('2026-11-01T00:01:00+08:00'), { timeZone: TZ }) ===
    renderCalendar(at('2026-11-01T23:59:00+08:00'), { timeZone: TZ }),
  '(应为 true)',
)
console.log(
  '跨天 renderCalendar 变化:',
  renderCalendar(at('2026-11-01T23:59:00+08:00'), { timeZone: TZ }) !==
    renderCalendar(at('2026-11-02T00:01:00+08:00'), { timeZone: TZ }),
  '(应为 true)',
)
console.log('L1 字符数:', renderClock(at('2026-11-01T19:09:00+08:00'), { timeZone: TZ }).length)
console.log('L2 字符数:', renderCalendar(at('2026-11-01T19:09:00+08:00'), { timeZone: TZ }).length)
