// The restricted expression language — one evaluator, used by pack-declared
// formulas. Pure, deterministic, side-effect free; no loops, no recursion in
// the language; depth ≤ 32, nodes ≤ 512. EXACT arithmetic throughout: every
// number is a rational (bigint pair), implicit rounding never occurs, and
// round(value, places, mode) is the ONLY narrowing anywhere. A money result
// must have been produced by an explicit round to 2 places or converting it
// refuses.
//
// Node encoding (the tree a pack declares — recorded implementation choice;
// numeric literals are STRINGS so no float ever taints a formula):
//   { lit: '8.50', type: 'money'|'decimal'|'integer'|'percent'|'boolean'
//                       |'date'|'duration_days'|'text' } { measure:
//                       'firm.held_total', args?: [node…] } { op:
//                       '+'|'-'|'*'|'/'|'neg'|'='|'!='|'<'|'<='|'>'|'>='|'and'|'or'|'not',
//                       args: [node…] } { fn:
//                       'if'|'min'|'max'|'abs'|'round'|'pct'|'value_or'|'has_value'
//                       |'days_between'|'add_days'|'business_days_between'
//                       |'add_business_days'|'month_end'|'year'|'month'|'in',
//                       args: [node…] } { list: [node…] } — only as in()'s
//                       second argument
//
// Failure discipline: shape and type problems refuse 'expression_invalid'
// (they should have been caught at activation — recorded owed work: wiring
// formula type-checking into pack activation once existing formula bodies
// migrate to this encoding); DATA conditions — a zero divisor, a measure with
// no value used bare — refuse 'integrity_refusal' (on money paths the refusal
// is captured); a measure outside the rule point's bound set refuses
// 'measure_not_bound'.

import { OperationRefused } from '@/lib/db'

// ---------------------------------------------------------------------------
// Exact rationals.
// ---------------------------------------------------------------------------

export interface Rat {
  p: bigint
  q: bigint // > 0, gcd(p, q) = 1
}

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a
  b = b < 0n ? -b : b
  while (b) {
    const t = a % b
    a = b
    b = t
  }
  return a
}

function rat(p: bigint, q: bigint): Rat {
  if (q === 0n) throw refuseData('division by zero')
  if (q < 0n) {
    p = -p
    q = -q
  }
  const g = gcd(p, q) || 1n
  return { p: p / g, q: q / g }
}

const radd = (a: Rat, b: Rat) => rat(a.p * b.q + b.p * a.q, a.q * b.q)
const rsub = (a: Rat, b: Rat) => rat(a.p * b.q - b.p * a.q, a.q * b.q)
const rmul = (a: Rat, b: Rat) => rat(a.p * b.p, a.q * b.q)
const rdiv = (a: Rat, b: Rat) => {
  if (b.p === 0n) throw refuseData('division by zero')
  return rat(a.p * b.q, a.q * b.p)
}
const rneg = (a: Rat) => rat(-a.p, a.q)
const rabs = (a: Rat) => rat(a.p < 0n ? -a.p : a.p, a.q)
const rcmp = (a: Rat, b: Rat) => {
  const l = a.p * b.q
  const r = b.p * a.q
  return l < r ? -1 : l > r ? 1 : 0
}

/** Parse an exact decimal string ('-12.345') into a rational. */
function parseDecimal(s: string): Rat {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s.trim())
  if (!m) throw refuseShape(`'${s}' is not an exact number`)
  const sign = m[1] === '-' ? -1n : 1n
  const whole = BigInt(m[2])
  const frac = m[3] ?? ''
  const scale = 10n ** BigInt(frac.length)
  return rat(sign * (whole * scale + BigInt(frac || '0')), scale)
}

// ---------------------------------------------------------------------------
// Values.
// ---------------------------------------------------------------------------

export type Value =
  | { t: 'boolean'; v: boolean }
  | { t: 'integer'; v: bigint }
  | { t: 'decimal'; v: Rat }
  | { t: 'money'; v: Rat; rounded: boolean }
  | { t: 'date'; v: string } // ISO yyyy-mm-dd
  | { t: 'duration_days'; v: bigint }
  | { t: 'text'; v: string }

export const money = (cents: number): Value => ({
  t: 'money',
  v: rat(BigInt(Math.round(cents)), 100n),
  rounded: true,
})
export const decimal = (s: string): Value => ({ t: 'decimal', v: parseDecimal(s) })
export const integer = (n: number | bigint): Value => ({ t: 'integer', v: BigInt(n) })
export const dateValue = (iso: string): Value => ({ t: 'date', v: assertIso(iso) })
export const text = (s: string): Value => ({ t: 'text', v: s })

function refuseShape(msg: string): OperationRefused {
  return new OperationRefused('expression_invalid', msg)
}
function refuseData(msg: string): OperationRefused {
  return new OperationRefused('integrity_refusal', msg)
}

function assertIso(s: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s + 'T00:00:00Z'))) {
    throw refuseShape(`'${s}' is not an ISO date`)
  }
  return s
}

function asNumeric(v: Value, what: string): Rat {
  if (v.t === 'integer') return rat(v.v, 1n)
  if (v.t === 'decimal') return v.v
  if (v.t === 'money') return v.v
  throw refuseShape(`${what} needs a number, got ${v.t}`)
}

/** money survives arithmetic (unrounded until an explicit round). */
function numericResult(a: Value, b: Value | null, r: Rat): Value {
  if (a.t === 'money' || b?.t === 'money') return { t: 'money', v: r, rounded: false }
  if (a.t === 'decimal' || b?.t === 'decimal' || r.q !== 1n) return { t: 'decimal', v: r }
  return { t: 'integer', v: r.p }
}

/**
 * The one exit for money: exact cents, only from an explicitly rounded
 * result: a money output must end in an explicit round(…, 2, …).
 */
export function moneyCents(v: Value): number {
  if (v.t !== 'money') throw refuseShape(`expected money, got ${v.t}`)
  if (!v.rounded || 100n % v.v.q !== 0n) {
    throw refuseShape('a money output must end in an explicit round(…, 2, …)')
  }
  const cents = (v.v.p * 100n) / v.v.q
  if (cents > 9007199254740991n || cents < -9007199254740991n) {
    throw refuseData('money result out of range')
  }
  return Number(cents)
}

// ---------------------------------------------------------------------------
// Dates and the business calendar.
// ---------------------------------------------------------------------------

export interface BusinessCalendar {
  /** JS weekday numbers that do not work (0 = Sunday … 6 = Saturday). */
  nonWorking: number[]
  holidays?: string[]
}

/** The neutral calendar: Saturday/Sunday non-working, no holidays. */
export const NEUTRAL_CALENDAR: BusinessCalendar = { nonWorking: [0, 6] }

const DAY = 86_400_000
const toEpoch = (iso: string) => Date.parse(iso + 'T00:00:00Z')
const fromEpoch = (ms: number) => new Date(ms).toISOString().slice(0, 10)

function isWorking(iso: string, cal: BusinessCalendar): boolean {
  const d = new Date(toEpoch(iso))
  if (cal.nonWorking.includes(d.getUTCDay())) return false
  return !(cal.holidays ?? []).includes(iso)
}

/** Working days in (a, b] — negative when b < a (symmetric definition). */
function businessDaysBetween(a: string, b: string, cal: BusinessCalendar): bigint {
  let from = toEpoch(a)
  let to = toEpoch(b)
  const sign = to >= from ? 1n : -1n
  if (to < from) [from, to] = [to, from]
  let n = 0n
  for (let t = from + DAY; t <= to; t += DAY) {
    if (isWorking(fromEpoch(t), cal)) n += 1n
  }
  return sign * n
}

function addBusinessDays(iso: string, n: bigint, cal: BusinessCalendar): string {
  let t = toEpoch(iso)
  const step = n < 0n ? -DAY : DAY
  let left = n < 0n ? -n : n
  while (left > 0n) {
    t += step
    if (isWorking(fromEpoch(t), cal)) left -= 1n
  }
  return fromEpoch(t)
}

// ---------------------------------------------------------------------------
// The evaluator.
// ---------------------------------------------------------------------------

export type MeasureResolver = (name: string, args: Value[]) => Promise<Value | null>

export interface EvalContext {
  /** The rule point's bound measure names — anything else refuses. */
  measures: Set<string>
  resolve: MeasureResolver
  calendar?: BusinessCalendar
}

type Node = Record<string, unknown>

function countNodes(n: unknown): number {
  if (n === null || typeof n !== 'object') return 1
  let total = 1
  for (const v of Object.values(n as Node)) {
    if (Array.isArray(v)) for (const c of v) total += countNodes(c)
    else if (typeof v === 'object' && v !== null) total += countNodes(v)
  }
  return total
}

export async function evaluateExpression(doc: unknown, ctx: EvalContext): Promise<Value> {
  if (countNodes(doc) > 512) throw refuseShape('expression exceeds 512 nodes')
  return evalNode(doc, ctx, 0)
}

async function evalNode(node: unknown, ctx: EvalContext, depth: number): Promise<Value> {
  if (depth > 32) throw refuseShape('expression exceeds depth 32')
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw refuseShape('every expression node is an object')
  }
  const n = node as Node

  if ('lit' in n) return literal(n)
  if ('measure' in n) {
    const v = await measureValue(n, ctx, depth)
    if (v === null) throw refuseData(`measure ${String(n.measure)} has no value`)
    return v
  }
  if ('op' in n) return operator(n, ctx, depth)
  if ('fn' in n) return fn(n, ctx, depth)
  if ('list' in n) throw refuseShape('a list belongs only inside in()')
  throw refuseShape(`unknown node shape: ${Object.keys(n).join(',')}`)
}

function literal(n: Node): Value {
  const type = n.type as string
  const raw = n.lit
  switch (type) {
    case 'boolean':
      if (typeof raw !== 'boolean') throw refuseShape('boolean literal must be true/false')
      return { t: 'boolean', v: raw }
    case 'text':
      if (typeof raw !== 'string') throw refuseShape('text literal must be a string')
      return { t: 'text', v: raw }
    case 'date':
      return { t: 'date', v: assertIso(String(raw)) }
    case 'duration_days': {
      const m = /^P(\d+)D$/.exec(String(raw))
      const days = m ? BigInt(m[1]) : BigInt(parseIntStrict(String(raw)))
      return { t: 'duration_days', v: days }
    }
    case 'integer':
      return { t: 'integer', v: BigInt(parseIntStrict(String(raw))) }
    case 'decimal':
      return { t: 'decimal', v: parseDecimal(String(raw)) }
    case 'money':
      return { t: 'money', v: parseDecimal(String(raw)), rounded: centsExact(String(raw)) }
    case 'percent':
      // 8.5% ≡ decimal 0.085
      return { t: 'decimal', v: rdiv(parseDecimal(String(raw).replace(/%$/, '')), rat(100n, 1n)) }
    default:
      throw refuseShape(`unknown literal type '${type}'`)
  }
}

function parseIntStrict(s: string): string {
  if (!/^-?\d+$/.test(s.trim())) throw refuseShape(`'${s}' is not an integer`)
  return s.trim()
}

function centsExact(s: string): boolean {
  const r = parseDecimal(s)
  return 100n % r.q === 0n
}

async function measureValue(n: Node, ctx: EvalContext, depth: number): Promise<Value | null> {
  const name = String(n.measure)
  if (!ctx.measures.has(name)) {
    throw new OperationRefused('measure_not_bound', `this rule point does not bind ${name}`)
  }
  const args: Value[] = []
  for (const a of (n.args as unknown[]) ?? []) args.push(await evalNode(a, ctx, depth + 1))
  return ctx.resolve(name, args)
}

async function operator(n: Node, ctx: EvalContext, depth: number): Promise<Value> {
  const op = String(n.op)
  const argNodes = (n.args as unknown[]) ?? []

  // short-circuit logic first
  if (op === 'and' || op === 'or') {
    if (argNodes.length < 2) throw refuseShape(`${op} needs two or more arguments`)
    for (const a of argNodes) {
      const v = await evalNode(a, ctx, depth + 1)
      if (v.t !== 'boolean') throw refuseShape(`${op} needs booleans`)
      if (op === 'and' && !v.v) return { t: 'boolean', v: false }
      if (op === 'or' && v.v) return { t: 'boolean', v: true }
    }
    return { t: 'boolean', v: op === 'and' }
  }
  if (op === 'not') {
    const v = await evalNode(argNodes[0], ctx, depth + 1)
    if (v.t !== 'boolean') throw refuseShape('not needs a boolean')
    return { t: 'boolean', v: !v.v }
  }
  if (op === 'neg') {
    const v = await evalNode(argNodes[0], ctx, depth + 1)
    const r = rneg(asNumeric(v, 'unary minus'))
    return numericResult(v, null, r)
  }

  if (argNodes.length !== 2) throw refuseShape(`${op} takes exactly two arguments`)
  const a = await evalNode(argNodes[0], ctx, depth + 1)
  const b = await evalNode(argNodes[1], ctx, depth + 1)

  switch (op) {
    case '+':
    case '-': {
      // date ± duration; duration ± duration; numbers
      if (a.t === 'date' && b.t === 'duration_days') {
        const ms = toEpoch(a.v) + Number(op === '+' ? b.v : -b.v) * DAY
        return { t: 'date', v: fromEpoch(ms) }
      }
      if (a.t === 'duration_days' && b.t === 'duration_days') {
        return { t: 'duration_days', v: op === '+' ? a.v + b.v : a.v - b.v }
      }
      const r = op === '+' ? radd(asNumeric(a, op), asNumeric(b, op)) : rsub(asNumeric(a, op), asNumeric(b, op))
      return numericResult(a, b, r)
    }
    case '*': {
      if (a.t === 'money' && b.t === 'money') throw refuseShape('money × money has no meaning')
      return numericResult(a, b, rmul(asNumeric(a, op), asNumeric(b, op)))
    }
    case '/': {
      const r = rdiv(asNumeric(a, op), asNumeric(b, op))
      if (a.t === 'money' && b.t === 'money') return { t: 'decimal', v: r } // a ratio
      return numericResult(a, b, r)
    }
    case '=':
    case '!=':
    case '<':
    case '<=':
    case '>':
    case '>=': {
      const c = compare(a, b, op)
      return { t: 'boolean', v: c }
    }
    default:
      throw refuseShape(`unknown operator '${op}'`)
  }
}

function compare(a: Value, b: Value, op: string): boolean {
  let c: number
  if (a.t === 'text' || b.t === 'text') {
    if (a.t !== 'text' || b.t !== 'text') throw refuseShape('text compares only with text')
    if (op !== '=' && op !== '!=') throw refuseShape('text supports equality only')
    c = a.v === b.v ? 0 : 1
  } else if (a.t === 'boolean' || b.t === 'boolean') {
    if (a.t !== 'boolean' || b.t !== 'boolean') throw refuseShape('boolean compares with boolean')
    if (op !== '=' && op !== '!=') throw refuseShape('booleans support equality only')
    c = a.v === b.v ? 0 : 1
  } else if (a.t === 'date' || b.t === 'date') {
    if (a.t !== 'date' || b.t !== 'date') throw refuseShape('dates compare with dates')
    c = a.v < b.v ? -1 : a.v > b.v ? 1 : 0
  } else if (a.t === 'duration_days' || b.t === 'duration_days') {
    if (a.t !== 'duration_days' || b.t !== 'duration_days') {
      throw refuseShape('durations compare with durations')
    }
    c = a.v < b.v ? -1 : a.v > b.v ? 1 : 0
  } else {
    c = rcmp(asNumeric(a, op), asNumeric(b, op))
  }
  switch (op) {
    case '=':
      return c === 0
    case '!=':
      return c !== 0
    case '<':
      return c < 0
    case '<=':
      return c <= 0
    case '>':
      return c > 0
    default:
      return c >= 0
  }
}

async function fn(n: Node, ctx: EvalContext, depth: number): Promise<Value> {
  const name = String(n.fn)
  const argNodes = (n.args as unknown[]) ?? []
  const cal = ctx.calendar ?? NEUTRAL_CALENDAR
  const ev = (i: number) => evalNode(argNodes[i], ctx, depth + 1)

  switch (name) {
    case 'if': {
      if (argNodes.length !== 3) throw refuseShape('if(condition, then, else)')
      const c = await ev(0)
      if (c.t !== 'boolean') throw refuseShape('if needs a boolean condition')
      const chosen = await evalNode(argNodes[c.v ? 1 : 2], ctx, depth + 1)
      return chosen
    }
    case 'min':
    case 'max': {
      if (argNodes.length < 2) throw refuseShape(`${name} needs two or more arguments`)
      let best: Value | null = null
      for (let i = 0; i < argNodes.length; i++) {
        const v = await ev(i)
        if (best === null) best = v
        else {
          const c = rcmp(asNumeric(v, name), asNumeric(best, name))
          if ((name === 'min' && c < 0) || (name === 'max' && c > 0)) best = v
        }
      }
      return best!
    }
    case 'abs': {
      const v = await ev(0)
      return numericResult(v, null, rabs(asNumeric(v, 'abs')))
    }
    case 'round': {
      if (argNodes.length !== 3) throw refuseShape('round(value, places, mode)')
      const v = await ev(0)
      const places = await ev(1)
      const mode = await ev(2)
      if (places.t !== 'integer' || places.v < 0n || places.v > 10n) {
        throw refuseShape('round places must be an integer 0…10')
      }
      if (mode.t !== 'text' || !['half_up', 'up', 'down'].includes(mode.v)) {
        throw refuseShape("round mode is 'half_up', 'up' or 'down'")
      }
      const r = asNumeric(v, 'round')
      const scale = 10n ** places.v
      const num = r.p * scale
      const div = r.q
      let q = num / div
      const rem = num % div
      if (rem !== 0n) {
        const sign = num < 0n ? -1n : 1n
        const absRem = rem < 0n ? -rem : rem
        if (mode.v === 'up') q += sign
        else if (mode.v === 'half_up' && absRem * 2n >= div) q += sign
        // 'down' truncates toward zero — q already is
      }
      const rounded = rat(q, scale)
      if (v.t === 'money') return { t: 'money', v: rounded, rounded: places.v <= 2n }
      if (v.t === 'integer' && places.v === 0n) return { t: 'integer', v: rounded.p }
      return { t: 'decimal', v: rounded }
    }
    case 'pct': {
      if (argNodes.length !== 2) throw refuseShape('pct(value, percent)')
      const v = await ev(0)
      const p = await ev(1)
      const r = rmul(asNumeric(v, 'pct'), asNumeric(p, 'pct'))
      return numericResult(v, p, r)
    }
    case 'has_value':
    case 'value_or': {
      const m = argNodes[0] as Node
      if (m === null || typeof m !== 'object' || !('measure' in m)) {
        throw refuseShape(`${name} takes a measure`)
      }
      const got = await measureValue(m, ctx, depth + 1)
      if (name === 'has_value') return { t: 'boolean', v: got !== null }
      if (got !== null) return got
      return evalNode(argNodes[1], ctx, depth + 1)
    }
    case 'days_between': {
      const a = await ev(0)
      const b = await ev(1)
      if (a.t !== 'date' || b.t !== 'date') throw refuseShape('days_between(date, date)')
      return { t: 'duration_days', v: BigInt(Math.round((toEpoch(b.v) - toEpoch(a.v)) / DAY)) }
    }
    case 'add_days': {
      const d = await ev(0)
      const nDays = await ev(1)
      if (d.t !== 'date' || (nDays.t !== 'integer' && nDays.t !== 'duration_days')) {
        throw refuseShape('add_days(date, days)')
      }
      return { t: 'date', v: fromEpoch(toEpoch(d.v) + Number(nDays.v) * DAY) }
    }
    case 'business_days_between': {
      const a = await ev(0)
      const b = await ev(1)
      if (a.t !== 'date' || b.t !== 'date') throw refuseShape('business_days_between(date, date)')
      return { t: 'duration_days', v: businessDaysBetween(a.v, b.v, cal) }
    }
    case 'add_business_days': {
      const d = await ev(0)
      const nDays = await ev(1)
      if (d.t !== 'date' || (nDays.t !== 'integer' && nDays.t !== 'duration_days')) {
        throw refuseShape('add_business_days(date, days)')
      }
      return { t: 'date', v: addBusinessDays(d.v, nDays.v, cal) }
    }
    case 'month_end': {
      const d = await ev(0)
      if (d.t !== 'date') throw refuseShape('month_end(date)')
      const dt = new Date(toEpoch(d.v))
      const end = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0))
      return { t: 'date', v: end.toISOString().slice(0, 10) }
    }
    case 'year':
    case 'month': {
      const d = await ev(0)
      if (d.t !== 'date') throw refuseShape(`${name}(date)`)
      const dt = new Date(toEpoch(d.v))
      return { t: 'integer', v: BigInt(name === 'year' ? dt.getUTCFullYear() : dt.getUTCMonth() + 1) }
    }
    case 'in': {
      const v = await ev(0)
      if (v.t !== 'text') throw refuseShape('in(value, list) enumerates text')
      const listNode = argNodes[1] as Node
      if (listNode === null || typeof listNode !== 'object' || !('list' in listNode)) {
        throw refuseShape('in() needs a list as its second argument')
      }
      for (const item of listNode.list as unknown[]) {
        const iv = await evalNode(item, ctx, depth + 1)
        if (iv.t !== 'text') throw refuseShape('in() lists text')
        if (iv.v === v.v) return { t: 'boolean', v: true }
      }
      return { t: 'boolean', v: false }
    }
    default:
      throw refuseShape(`unknown function '${name}'`)
  }
}
