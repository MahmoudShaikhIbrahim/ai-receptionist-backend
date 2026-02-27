const { DateTime } = require("luxon");

function nowInTZ(tz) {
  return DateTime.now().setZone(tz);
}

function toISODateInTZ(dt, tz) {
  return DateTime.fromJSDate(dt).setZone(tz).toISODate();
}

function buildStartEndInTZ({ tz, dateISO, time24, durationMinutes }) {
  const [hh, mm] = time24.split(":").map((n) => parseInt(n, 10));
  const start = DateTime.fromISO(`${dateISO}T00:00:00`, { zone: tz })
    .set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
  const end = start.plus({ minutes: durationMinutes });
  return { start: start.toJSDate(), end: end.toJSDate() };
}

module.exports = { nowInTZ, toISODateInTZ, buildStartEndInTZ };