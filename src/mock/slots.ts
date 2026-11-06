import { addDays, weekday } from "../clock.ts";
import type { Provider } from "./catalog.ts";

const MAX_DAYS = 45; // stops a huge date range from running away

// Every slot a provider offers in a date range, before removing taken ones.
// Slots are full ISO strings in IST, so they sort correctly as plain text.
export function generateSlots(provider: Provider, from: string, to: string): string[] {
  const slots: string[] = [];
  let date = from;
  for (let day = 0; day < MAX_DAYS && date <= to; day++) {
    if (provider.days.includes(weekday(date))) {
      for (const hour of provider.hours) {
        slots.push(`${date}T${String(hour).padStart(2, "0")}:00:00+05:30`);
      }
    }
    date = addDays(date, 1);
  }
  return slots;
}
