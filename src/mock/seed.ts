import type { DatabaseSync } from "node:sqlite";
import { addDays, istDate, weekday, type Clock } from "../clock.ts";

export const SEED_USER = "u1";
export const PAST_ELECTRICIAN_BOOKING = "B-0001";
export const UPCOMING_AC_BOOKING = "B-0002";

export function insertBooking(
  db: DatabaseSync,
  booking: { booking_id: string; user_id: string; provider_id: string; service: string; slot: string; price: number; hold_id?: string },
): void {
  db.prepare(
    `INSERT INTO bookings (booking_id, user_id, provider_id, service, slot, price, status, hold_id)
     VALUES (?, ?, ?, ?, ?, ?, 'booked', ?)`,
  ).run(booking.booking_id, booking.user_id, booking.provider_id, booking.service, booking.slot, booking.price, booking.hold_id ?? null);
}

// Gives u1 the history the PDF's example requests rely on:
// "the same electrician as last time" and "my AC servicing".
// Dates are relative to the clock so the demo works on any day.
export function seedBookings(db: DatabaseSync, clock: Clock): void {
  const today = istDate(clock.now());
  const inThreeDays = addDays(today, 3);
  // Keep the AC service off a Saturday so "move it to Saturday" is a real move.
  const acDate = weekday(inThreeDays) === 6 ? addDays(today, 4) : inThreeDays;

  insertBooking(db, {
    booking_id: PAST_ELECTRICIAN_BOOKING, user_id: SEED_USER, provider_id: "el_1", service: "electrician",
    slot: `${addDays(today, -18)}T11:00:00+05:30`, price: 600,
  });
  insertBooking(db, {
    booking_id: UPCOMING_AC_BOOKING, user_id: SEED_USER, provider_id: "ac_1", service: "ac_service",
    slot: `${acDate}T15:00:00+05:30`, price: 1200,
  });
}
