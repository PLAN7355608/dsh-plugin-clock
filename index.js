/**
 * dsh-plugin-clock —— 给模型挂一块「墙上的钟」
 *
 * 病根（已在 dsh-time-context 源码与 682 个 step 的实测里核实）：
 *   1. refreshIntervalMs 默认 600000，读数硬节流 10 分钟，长 turn 里模型拿几分钟前的
 *      时间戳估时间；44.4% 的 step 看到的是 ≥5 分钟前的钟。
 *   2. 读数只往历史里追加，没有「作废」语义。
 *   3. system prompt / runtime context 里根本没有日期与星期锚。
 *
 * 修法分两条通道，各干各的事：
 *
 *   A. 日历（一天只变一次）→ 注册成 required 的 prompt context。
 *      SystemPrompt.refreshContext() 每个 step 都会重跑 context provider，
 *      但 agent-loop 只在**文本变化**时才追加新快照，所以日历一天只产生一条。
 *      放这里是因为它稳定：跨天翻篇、星期、ISO 周、本月剩几天、昨天/明天都能预计算。
 *
 *   B. 时刻（分钟级）→ 挂在 agent/pre-step 上，注入一条 ~120 字符的极短 user 消息。
 *      为什么不放进 context：runtime-context 快照会带上所有插件的上下文（实测 2427 字符
 *      ≈758 token），每分钟重发一次等于 45k token/小时；而一条独立短消息只有 ~35 token。
 *      这也是内置 time-context 用的通道，我们只是把它的 600s 节流换成「分钟翻页」。
 *
 * 刻意不做：clock 工具（模型不会主动看表，手表式方案等于没装）、秒级显示、
 * 猜「这次是不是在问时间」。
 */

import { randomUUID } from 'node:crypto'

/** 插件名。必须和 package.json 里的 name 完全一致，否则 DSH 找不到它。 */
export const name = 'dsh-plugin-clock'

/** 依赖的服务：systemPrompt 就绪前不启用 apply。 */
export const inject = ['systemPrompt']

const DAY_MS = 86400000
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** 每个时区缓存一组 formatter，避免每步重建。 */
const formatterCache = new Map()

function formattersFor(timeZone) {
  let hit = formatterCache.get(timeZone)
  if (hit === undefined) {
    hit = {
      clock: new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }),
      offset: new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }),
    }
    formatterCache.set(timeZone, hit)
  }
  return hit
}

/** 把一个瞬间渲染成指定时区的墙钟零件。 */
function zoneParts(date, timeZone) {
  const out = {}
  for (const part of formattersFor(timeZone).clock.formatToParts(date)) {
    if (part.type !== 'literal') out[part.type] = part.value
  }
  return out
}

/** UTC 偏移，渲染成 `+08:00` 这种形式。 */
function zoneOffset(date, timeZone) {
  const raw = formattersFor(timeZone).offset
    .formatToParts(date)
    .find((part) => part.type === 'timeZoneName')?.value ?? 'GMT'
  if (raw === 'GMT') return '+00:00'
  const m = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(raw)
  if (m === null) return raw
  return `${m[1]}${m[2].padStart(2, '0')}:${m[3] ?? '00'}`
}

/** 偏移的分钟数（东八区 = 480）。 */
function zoneOffsetMinutes(date, timeZone) {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(zoneOffset(date, timeZone))
  if (m === null) return 0
  const total = Number(m[2]) * 60 + Number(m[3])
  return m[1] === '-' ? -total : total
}

/**
 * 取「同一时区里的某一天中午」对应的瞬间，再按天数平移。
 * 这样 yesterday / tomorrow 是日历意义上的相邻日，夏令时切换日也不会跳错。
 */
function neighborDay(date, timeZone, days) {
  const today = zoneParts(date, timeZone)
  const noonUtc =
    Date.UTC(Number(today.year), Number(today.month) - 1, Number(today.day), 12, 0) -
    zoneOffsetMinutes(date, timeZone) * 60000
  return zoneParts(new Date(noonUtc + days * DAY_MS), timeZone)
}

/** ISO 8601 周号。 */
function isoWeek(year, month, day) {
  const utc = Date.UTC(year, month - 1, day)
  const mondayIndex = (new Date(utc).getUTCDay() + 6) % 7
  const thursday = utc + (3 - mondayIndex) * DAY_MS
  const jan1 = Date.UTC(new Date(thursday).getUTCFullYear(), 0, 1)
  return Math.floor((thursday - jan1) / DAY_MS / 7) + 1
}

function weekdayOf(parts) {
  return WEEKDAYS[
    new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day))).getUTCDay()
  ]
}

function dateLabel(parts) {
  return `${parts.year}-${parts.month}-${parts.day} ${weekdayOf(parts).slice(0, 3)}`
}

/** 分钟级的「现在」，作为去重键。 */
export function minuteKey(date, timeZone) {
  const p = zoneParts(date, timeZone)
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`
}

/**
 * L1：时刻。注入成独立的极短 user 消息，每个 step 都可能刷新，但同一分钟内只发一次。
 * 纯函数，方便离线测试。
 */
export function renderClock(date, options = {}) {
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const p = zoneParts(date, timeZone)
  return (
    `Clock: ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ` +
    `${weekdayOf(p).slice(0, 3)} · ${timeZone} (UTC${zoneOffset(date, timeZone)}) — ` +
    `the actual time as this step started, newer than any earlier clock line.`
  )
}

/**
 * L2：日历。注册成 prompt context，一天只变一次，所以一天只产生一条快照。
 */
export function renderCalendar(date, options = {}) {
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const p = zoneParts(date, timeZone)
  const year = Number(p.year)
  const month = Number(p.month)
  const day = Number(p.day)
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()

  return [
    `Calendar: ${p.year}-${p.month}-${p.day} ${weekdayOf(p)} · ${timeZone} (UTC${zoneOffset(date, timeZone)})`,
    `yesterday ${dateLabel(neighborDay(date, timeZone, -1))} · ` +
      `tomorrow ${dateLabel(neighborDay(date, timeZone, 1))} · ` +
      `ISO week ${isoWeek(year, month, day)} · ${daysInMonth - day} day(s) left in ${MONTHS[month - 1]}`,
    `The newest "Clock:" line in this conversation is the current time. ` +
      `Take times and dates from these lines instead of estimating or recomputing them.`,
  ].join('\n')
}

/** 插件入口。ctx.systemPrompt 由 inject 保证已就绪。 */
export function apply(ctx, config = {}) {
  const timeZone = config.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const order = typeof config.order === 'number' ? config.order : 105
  const injectClock = config.injectClockLine !== false
  // 内置 time-context 仍会每 10 分钟插一条旧格式读数，且没有作废语义。默认把它们挡掉，
  // 免得会话里同时存在两个时间来源、模型不知道该信哪个。
  const dropBuiltinTimeContext = config.dropBuiltinTimeContext !== false

  // ⚠️ 日历文本里**绝不能**出现分钟，否则每个 step 文本都变，等于每分钟重发 758 token 的快照。
  ctx.systemPrompt.context({
    name: 'clock:calendar',
    order,
    // required: true → 即使 runtime context 被 suppress 也不会被过滤掉
    required: true,
    // interpolate: false → 文本里的 {{...}} 不当变量展开
    interpolate: false,
    text: () => renderCalendar(new Date(), { timeZone }),
  })

  if (!injectClock) return

  /** 每个 agent 上次注入到的分钟；同一分钟内的多个 step 不重复发。 */
  const lastMinute = new Map()

  ctx.on(
    'agent/pre-step',
    async ({ agent, signal }, next) => {
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision

      const kept = dropBuiltinTimeContext
        ? decision.messages.filter((message) => message.source?.kind !== 'time-context')
        : decision.messages

      const now = new Date()
      const key = minuteKey(now, timeZone)
      const scope = agent.session?.id ?? agent.id
      if (lastMinute.get(scope) === key) return { ...decision, messages: kept }
      lastMinute.set(scope, key)

      const message = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: renderClock(now, { timeZone }) }],
        // 和内置 time-context 一样走 user/message，但换一个 source.kind 便于区分与排查
        source: { kind: 'clock', form: 'snapshot' },
      }
      return { ...decision, messages: [...kept, message] }
    },
    // prepend: 包住其它 pre-step 处理器，拿到最终 decision 再追加
    { prepend: true },
  )
}
