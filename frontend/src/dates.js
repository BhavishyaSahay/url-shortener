// Helpers for the <input type="datetime-local"> used for link expiry.
// That input works in the user's local time with no timezone ("2026-12-31T23:59"),
// while the API uses ISO dates in UTC ("2026-12-31T18:29:00.000Z").

/** ISO date from the API → value for the input ('' when there's no date). */
export function toInputValue(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  // Shift by the timezone offset so toISOString() prints local time, then cut off seconds and "Z".
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** Input value → ISO date for the API (null when empty). */
export function toIsoDate(inputValue) {
  return inputValue ? new Date(inputValue).toISOString() : null;
}

export function formatDate(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
