/** ترکیب کلاس‌ها؛ مقادیر خالی/نادرست را رد می‌کند. */
export function cx(
  ...parts: Array<string | false | null | undefined>
): string {
  return parts.filter(Boolean).join(" ");
}
