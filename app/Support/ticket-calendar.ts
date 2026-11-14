import { addDays, calendarDay, clockMinutes, isCalendarDate, isTimeZone, localDateRange, todayIn, zonedTimeToUtc } from '@stacksjs/datetime'
import { fail } from './errors'
import { object } from './service'

export interface BusinessHours { timeZone: string, windows: { weekdays: number[], start: string, end: string }[], holidays: string[] }
const horizon = 3660
export function parseBusinessHours(input: unknown): BusinessHours {
  const value = object(input), timeZone = String(value.timeZone || 'UTC')
  if (!isTimeZone(timeZone)) fail(422, 'invalid_calendar', 'Use a named IANA time zone.')
  if (!Array.isArray(value.windows) || !value.windows.length || value.windows.length > 28) fail(422, 'invalid_calendar', 'Supply between 1 and 28 weekly windows.')
  const windows = value.windows.map(raw => {
    const row = object(raw), start = String(row.start), end = String(row.end)
    let first = -1, last = -1
    try { first = clockMinutes(start); last = end === '24:00' ? 1440 : clockMinutes(end) } catch { fail(422, 'invalid_calendar', 'Use HH:mm times. Split overnight windows at midnight.') }
    if (first >= last || !Array.isArray(row.weekdays) || !row.weekdays.length || row.weekdays.some(day => !Number.isInteger(day) || Number(day) < 0 || Number(day) > 6)) fail(422, 'invalid_calendar', 'Windows must end after they start and specify weekdays 0 through 6.')
    return { weekdays: [...new Set(row.weekdays as number[])], start, end }
  })
  const holidays = value.holidays ?? []
  if (!Array.isArray(holidays) || holidays.length > 366 || holidays.some(date => typeof date !== 'string' || !isCalendarDate(date))) fail(422, 'invalid_calendar', 'Supply up to 366 YYYY-MM-DD holiday dates.')
  return { timeZone, windows, holidays: [...new Set(holidays as string[])] }
}
function spans(calendar: BusinessHours, date: string): [number, number][] {
  if (calendar.holidays.includes(date)) return []
  const weekday = ((calendarDay(date) + 4) % 7 + 7) % 7
  const values = calendar.windows.filter(window => window.weekdays.includes(weekday)).map(window => [zonedTimeToUtc(`${date}T${window.start}:00`, calendar.timeZone).getTime(), window.end === '24:00' ? localDateRange(date, date, calendar.timeZone).end.getTime() : zonedTimeToUtc(`${date}T${window.end}:00`, calendar.timeZone).getTime()] as [number, number]).filter(([start, end]) => start < end).sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const [start, end] of values) {
    const last = merged[merged.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}
/** Elapsed working milliseconds, with overlapping windows counted once and native DST semantics. */
export function workingElapsed(calendar: BusinessHours | null, from: number, to: number): number {
  if (to <= from) return 0
  if (!calendar) return to - from
  let total = 0, date = todayIn(calendar.timeZone, new Date(from))
  const last = todayIn(calendar.timeZone, new Date(to))
  for (let day = 0; date <= last && day < horizon; day++, date = addDays(date, 1)) {
    for (const [start, end] of spans(calendar, date)) total += Math.max(0, Math.min(to, end) - Math.max(from, start))
    if (date === last) return total
  }
  fail(422, 'calendar_horizon', 'SLA calculations support at most ten calendar years.')
}
export function workingDeadline(calendar: BusinessHours | null, from: number, remaining: number): number {
  if (remaining <= 0) return from
  if (!calendar) return from + remaining
  let date = todayIn(calendar.timeZone, new Date(from))
  for (let day = 0; day < horizon; day++, date = addDays(date, 1)) {
    for (const [start, end] of spans(calendar, date)) {
      const first = Math.max(start, from), available = Math.max(0, end - first)
      if (available >= remaining) return first + remaining
      remaining -= available
    }
  }
  fail(422, 'calendar_horizon', 'This SLA target cannot be scheduled within ten calendar years.')
}
