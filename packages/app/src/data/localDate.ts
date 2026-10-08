/** YYYY-MM-DD from the device's local calendar, never from UTC. */
export function formatLocalDate(
  date: Pick<Date, "getFullYear" | "getMonth" | "getDate">,
): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
