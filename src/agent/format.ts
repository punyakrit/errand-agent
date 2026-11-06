import type { ApprovalCard } from "./approvals.ts";
import type { Option } from "./options.ts";

const IST = "Asia/Kolkata";

export function formatSlot(slot: string): string {
  const date = new Date(slot);
  const day = date.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: IST });
  const time = date.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: IST });
  return `${day}, ${time}`;
}

export function formatPrice(price: number): string {
  return `₹${price.toLocaleString("en-IN")}`;
}

const ACTION_WORDS = { book: "Book", cancel: "Cancel", reschedule: "Move" };

// The approval card is built from stored records, never from model text.
export function cardText(card: ApprovalCard): string {
  const lines = [
    "Please approve this:",
    `Action: ${ACTION_WORDS[card.action]}`,
    `Provider: ${card.provider_name}`,
  ];
  if (card.action === "reschedule") lines.push(`From: ${formatSlot(card.old_slot!)}`, `To: ${formatSlot(card.slot)}`);
  else lines.push(`Slot: ${formatSlot(card.slot)}`);
  lines.push(`Price: ${formatPrice(card.price)}`);
  if (card.hold_expires_at) lines.push(`Hold expires: ${formatSlot(card.hold_expires_at)}`);
  lines.push('Reply "yes" to approve, or tell me what to change.');
  return lines.join("\n");
}

export function optionsText(options: Option[]): string {
  return options
    .map((option, index) => {
      const slots = option.slots.slice(0, 3).map(formatSlot).join("; ");
      return `${index + 1}. ${option.name}, ${formatPrice(option.price)}, rated ${option.rating}: ${slots}`;
    })
    .join("\n");
}
