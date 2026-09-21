'use strict';
/**
 * lib/holidays.js — Dynamic Indian holiday & long-weekend engine
 * Replaces the hardcoded isLW() and LONG_WEEKENDS_2026 in the frontend.
 * Covers 2025–2028 with a lookup table for lunar/irregular holidays.
 */

// ── Fixed national holidays (same date every year) ───────────────────────────
const FIXED_HOLIDAYS = [
  { name: 'New Year',          mmdd: '01-01', type: 'national' },
  { name: 'Republic Day',      mmdd: '01-26', type: 'national' },
  { name: 'Independence Day',  mmdd: '08-15', type: 'national' },
  { name: 'Gandhi Jayanti',    mmdd: '10-02', type: 'national' },
  { name: 'Christmas',         mmdd: '12-25', type: 'national' },
];

// ── Lunar/irregular holidays by year ─────────────────────────────────────────
const VARIABLE_HOLIDAYS = {
  2025: [
    { name: 'Makar Sankranti',      date: '2025-01-14', type: 'festival'  },
    { name: 'Republic Day',         date: '2025-01-26', type: 'national'  },
    { name: 'Maha Shivratri',       date: '2025-02-26', type: 'festival'  },
    { name: 'Holi',                 date: '2025-03-14', type: 'festival'  },
    { name: 'Eid al-Fitr',          date: '2025-03-30', type: 'festival'  },
    { name: 'Ram Navami',           date: '2025-04-06', type: 'festival'  },
    { name: 'Good Friday',          date: '2025-04-18', type: 'national'  },
    { name: 'Baisakhi / Tamil NY',  date: '2025-04-13', type: 'festival'  },
    { name: 'Eid al-Adha',          date: '2025-06-07', type: 'festival'  },
    { name: 'Muharram',             date: '2025-07-05', type: 'festival'  },
    { name: 'Onam',                 date: '2025-09-05', type: 'festival'  },
    { name: 'Navratri Begin',       date: '2025-10-02', type: 'festival'  },
    { name: 'Dussehra',             date: '2025-10-02', type: 'festival'  },
    { name: 'Diwali',               date: '2025-10-20', type: 'festival'  },
    { name: 'Diwali Eve',           date: '2025-10-19', type: 'festival'  },
    { name: 'Bhai Dooj',            date: '2025-10-22', type: 'festival'  },
    { name: 'Guru Nanak Jayanti',   date: '2025-11-05', type: 'festival'  },
    { name: 'Christmas Eve',        date: '2025-12-24', type: 'festival'  },
    { name: 'New Year Eve',         date: '2025-12-31', type: 'festival'  },
  ],
  2026: [
    { name: 'Makar Sankranti',      date: '2026-01-14', type: 'festival'  },
    { name: 'Maha Shivratri',       date: '2026-02-15', type: 'festival'  },
    { name: 'Holi',                 date: '2026-03-04', type: 'festival'  },
    { name: 'Eid al-Fitr',          date: '2026-03-20', type: 'festival'  },
    { name: 'Ram Navami',           date: '2026-03-26', type: 'festival'  },
    { name: 'Good Friday',          date: '2026-04-03', type: 'national'  },
    { name: 'Baisakhi',             date: '2026-04-13', type: 'festival'  },
    { name: 'Eid al-Adha',          date: '2026-05-27', type: 'festival'  },
    { name: 'Muharram',             date: '2026-06-26', type: 'festival'  },
    { name: 'Onam',                 date: '2026-08-25', type: 'festival'  },
    { name: 'Navratri Begin',       date: '2026-10-09', type: 'festival'  },
    { name: 'Dussehra',             date: '2026-10-21', type: 'festival'  },
    { name: 'Diwali Eve',           date: '2026-11-06', type: 'festival'  },
    { name: 'Diwali',               date: '2026-11-07', type: 'festival'  },
    { name: 'Bhai Dooj',            date: '2026-11-09', type: 'festival'  },
    { name: 'Guru Nanak Jayanti',   date: '2026-10-25', type: 'festival'  },
    { name: 'Christmas Eve',        date: '2026-12-24', type: 'festival'  },
    { name: 'New Year Eve',         date: '2026-12-31', type: 'festival'  },
  ],
  2027: [
    { name: 'Makar Sankranti',      date: '2027-01-14', type: 'festival'  },
    { name: 'Maha Shivratri',       date: '2027-03-06', type: 'festival'  },
    { name: 'Holi',                 date: '2027-03-22', type: 'festival'  },
    { name: 'Eid al-Fitr',          date: '2027-03-09', type: 'festival'  },
    { name: 'Good Friday',          date: '2027-03-26', type: 'national'  },
    { name: 'Baisakhi',             date: '2027-04-13', type: 'festival'  },
    { name: 'Eid al-Adha',          date: '2027-05-17', type: 'festival'  },
    { name: 'Dussehra',             date: '2027-10-07', type: 'festival'  },
    { name: 'Diwali',               date: '2027-10-29', type: 'festival'  },
    { name: 'Christmas Eve',        date: '2027-12-24', type: 'festival'  },
    { name: 'New Year Eve',         date: '2027-12-31', type: 'festival'  },
  ],
  2028: [
    { name: 'Makar Sankranti',      date: '2028-01-15', type: 'festival'  },
    { name: 'Holi',                 date: '2028-03-11', type: 'festival'  },
    { name: 'Eid al-Fitr',          date: '2028-02-27', type: 'festival'  },
    { name: 'Dussehra',             date: '2028-10-24', type: 'festival'  },
    { name: 'Diwali',               date: '2028-11-15', type: 'festival'  },
    { name: 'Christmas Eve',        date: '2028-12-24', type: 'festival'  },
    { name: 'New Year Eve',         date: '2028-12-31', type: 'festival'  },
  ],
};

// ── Build the full holiday set for a given year ───────────────────────────────
function getHolidaysForYear(year) {
  const holidays = new Map(); // date string → holiday

  // Fixed holidays
  for (const h of FIXED_HOLIDAYS) {
    const date = `${year}-${h.mmdd}`;
    if (!holidays.has(date)) holidays.set(date, { ...h, date });
  }

  // Variable holidays
  const varList = VARIABLE_HOLIDAYS[year] || [];
  for (const h of varList) {
    if (!holidays.has(h.date)) holidays.set(h.date, h);
  }

  return holidays;
}

// ── Long-weekend detection ────────────────────────────────────────────────────
// A date is part of a "long weekend" if it's in a contiguous block that:
// - Includes at least one public holiday AND
// - Includes at least one weekend day (Sat/Sun) AND
// - The total block is >= 3 days
function computeLongWeekends(year) {
  const holidays = getHolidaysForYear(year);
  const blocks = [];

  // Collect all holiday + adjacent weekend clusters
  const allDates = new Set([...holidays.keys()]);

  // Expand: for each holiday, check if adjacent weekends/holidays attach
  const isWeekend = dateStr => {
    const d = new Date(dateStr + 'T00:00:00');
    return d.getDay() === 0 || d.getDay() === 6;
  };

  const addAdj = (dateStr, set) => {
    const d = new Date(dateStr + 'T00:00:00');
    for (let offset = -3; offset <= 3; offset++) {
      if (offset === 0) continue;
      const nd = new Date(d.getTime() + offset * 86400000);
      const ns = nd.toISOString().slice(0, 10);
      if (allDates.has(ns) || isWeekend(ns)) set.add(ns);
    }
  };

  const processed = new Set();
  for (const hDate of allDates) {
    if (processed.has(hDate)) continue;

    // BFS to collect this cluster
    const cluster = new Set([hDate]);
    const queue = [hDate];
    while (queue.length) {
      const cur = queue.shift();
      addAdj(cur, cluster);
      for (const added of cluster) {
        if (!processed.has(added)) {
          processed.add(added);
          queue.push(added);
        }
      }
    }

    const sorted = [...cluster].sort();
    const hasHoliday = sorted.some(d => allDates.has(d));
    const hasWeekend = sorted.some(d => isWeekend(d));
    if (hasHoliday && hasWeekend && sorted.length >= 3) {
      // Get holiday names for this cluster
      const names = sorted
        .filter(d => holidays.has(d))
        .map(d => holidays.get(d).name);
      blocks.push({ dates: sorted, name: names.join(' + '), start: sorted[0], end: sorted[sorted.length - 1] });
    }
  }

  // Deduplicate overlapping blocks
  const finalBlocks = [];
  const usedDates = new Set();
  for (const block of blocks.sort((a, b) => a.start.localeCompare(b.start))) {
    if (!block.dates.some(d => usedDates.has(d))) {
      block.dates.forEach(d => usedDates.add(d));
      finalBlocks.push(block);
    }
  }
  return finalBlocks;
}

// ── Date classification ───────────────────────────────────────────────────────
// Returns: 'national_holiday' | 'festival' | 'long_weekend' | 'weekend' | 'weekday'
function classifyDate(dateStr, year) {
  const holidays = getHolidaysForYear(year || parseInt(dateStr.slice(0, 4)));
  const lws = computeLongWeekends(year || parseInt(dateStr.slice(0, 4)));
  const d = new Date(dateStr + 'T00:00:00');
  const dow = d.getDay();

  if (holidays.has(dateStr)) {
    const h = holidays.get(dateStr);
    return h.type === 'national' ? 'national_holiday' : 'festival';
  }
  if (lws.some(lw => lw.dates.includes(dateStr))) return 'long_weekend';
  if (dow === 0 || dow === 6) return 'weekend';
  return 'weekday';
}

// ── Upcoming long weekends (for dashboard display) ───────────────────────────
function getUpcomingLongWeekends(fromDate, count = 6) {
  const fromYear = parseInt(fromDate.slice(0, 4));
  const allLws = [];
  for (let y = fromYear; y <= fromYear + 1; y++) {
    for (const lw of computeLongWeekends(y)) {
      if (lw.end >= fromDate) allLws.push(lw);
    }
  }
  return allLws.sort((a, b) => a.start.localeCompare(b.start)).slice(0, count);
}

module.exports = { getHolidaysForYear, computeLongWeekends, classifyDate, getUpcomingLongWeekends };
