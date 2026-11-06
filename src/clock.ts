// All time in the system comes through a Clock so tests can control it.
export interface Clock {
  now(): number; // epoch milliseconds
  sleep(ms: number): Promise<void>;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export class FakeClock implements Clock {
  private current: number;

  constructor(start: number | string = "2026-11-09T09:00:00+05:30") {
    this.current = typeof start === "string" ? Date.parse(start) : start;
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }

  // Waiting on a fake clock just moves it forward.
  async sleep(ms: number): Promise<void> {
    this.advance(ms);
  }
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Calendar date (YYYY-MM-DD) in India for an epoch time.
export function istDate(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// Adds whole days to a YYYY-MM-DD date.
export function addDays(date: string, days: number): string {
  const ms = Date.parse(`${date}T12:00:00+05:30`) + days * 24 * 60 * 60 * 1000;
  return istDate(ms);
}

// 0 = Sunday ... 6 = Saturday, for a YYYY-MM-DD date in India.
export function weekday(date: string): number {
  return new Date(`${date}T12:00:00+05:30`).getUTCDay();
}
