// ---------------------------------------------------------------------------
// src/scrape/scheduler.js — evaluate "HH:MM in SCHEDULE_TZ" as a real instant.
//
// The brief anchors two daily jobs to US time: flush at 23:30 and scrape at
// 00:00. The server runs wherever it runs, so we can't use local time. We also
// don't want a cron dependency. Instead we compute, for a given wall-clock
// "HH:MM" in a named IANA timezone, the next UTC instant it occurs, then arm a
// single setTimeout and re-arm after each fire (self-scheduling, DST-safe
// because we recompute against the zone every day).
//
// The zone math uses Intl.DateTimeFormat with timeZone — no external tz lib.
// ---------------------------------------------------------------------------
import { SCHEDULE_TZ } from "../config.js";

// What is the current wall-clock time in `tz`, as plain numbers?
function zonedParts(date, tz) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  // Intl can emit "24" for midnight hour on some engines; normalise.
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

// The UTC offset (ms) of `tz` at instant `date`. Positive = ahead of UTC.
function tzOffsetMs(date, tz) {
  const p = zonedParts(date, tz);
  // Treat the zoned wall-clock as if it were UTC, subtract the real UTC ms.
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Round `date` down to the second so the subtraction is a clean offset.
  const real = Math.floor(date.getTime() / 1000) * 1000;
  return asUtc - real;
}

/**
 * Next UTC Date at which the wall clock reads HH:MM in `tz`, strictly after
 * `from`. If today's HH:MM has already passed in the zone, returns tomorrow's.
 *
 * @param {string} hhmm  "23:30" / "00:00"
 * @param {Date}   from  reference instant (defaults now)
 * @param {string} tz    IANA zone (defaults SCHEDULE_TZ)
 */
export function nextOccurrence(hhmm, from = new Date(), tz = SCHEDULE_TZ) {
  const [h, m] = hhmm.split(":").map((n) => Number(n));
  // Start from the zone's current calendar day.
  const now = zonedParts(from, tz);

  const build = (dayOffset) => {
    // Construct the target wall-clock, then convert that zoned wall time to UTC
    // by applying the zone offset at (approximately) that instant.
    const guessUtc = Date.UTC(now.year, now.month - 1, now.day + dayOffset, h, m, 0);
    // guessUtc currently treats the wall time as UTC; correct by the offset the
    // zone has near that time. Two passes settle DST edges.
    let d = new Date(guessUtc - tzOffsetMs(new Date(guessUtc), tz));
    d = new Date(guessUtc - tzOffsetMs(d, tz));
    return d;
  };

  let target = build(0);
  if (target.getTime() <= from.getTime()) target = build(1);
  return target;
}

/**
 * Arm a self-re-scheduling daily job at HH:MM (SCHEDULE_TZ).
 *
 * @param {string}   hhmm     "23:30"
 * @param {function} job      async () => {}  — awaited each fire
 * @param {object}   opts     { tz?, onLog? }
 * @returns {{ cancel: () => void, nextAt: () => Date }}
 */
export function scheduleDaily(hhmm, job, { tz = SCHEDULE_TZ, onLog = () => {} } = {}) {
  let timer = null;
  let nextAt = null;
  let cancelled = false;

  const arm = () => {
    if (cancelled) return;
    nextAt = nextOccurrence(hhmm, new Date(), tz);
    const delay = Math.max(0, nextAt.getTime() - Date.now());
    onLog(`⏰ "${hhmm}" (${tz}) next fires ${nextAt.toISOString()} (in ${Math.round(delay / 1000)}s)`);
    timer = setTimeout(async () => {
      try {
        await job();
      } catch (err) {
        onLog(`Job "${hhmm}" threw: ${err.message}`);
      } finally {
        arm(); // re-arm for the next day
      }
    }, delay);
    if (timer.unref) timer.unref(); // don't keep the process alive solely for this
  };

  arm();
  return {
    cancel: () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    },
    nextAt: () => nextAt,
  };
}
