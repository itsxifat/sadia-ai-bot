// lib/date.js
export function dhakaDate(ts) {
  try {
    return new Intl.DateTimeFormat(
      process.env.SADIA_LOCALE || "bn-BD",
      { timeZone: "Asia/Dhaka", year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }
    ).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString();
  }
}
