/** Date-only values (due dates, week starts) are calendar days in UTC; format them without shifting to local time. */
export const formatDay = (iso: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" }) =>
  new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString(undefined, { ...opts, timeZone: "UTC" });

/** Instants (audit events, created-at) are shown in the viewer's local time. */
export const formatInstant = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
