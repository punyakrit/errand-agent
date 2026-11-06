import { buildOptions, type Option } from "./options.ts";
import type { Run } from "./run.ts";
import type { Task } from "./tasks.ts";

export type SearchOutcome =
  | { kind: "options"; options: Option[]; removed: Record<string, number> }
  | { kind: "requested_provider_no_fit"; name: string; otherSlots: string[]; others: Option[] }
  | { kind: "nothing_fits"; removed: Record<string, number> }
  | { kind: "error"; error: string };

// Each option keeps the message it was first offered in. A repeat search must
// not make something the user has already seen look new.
function saveOptions(run: Run, task: Task, options: Option[]): void {
  const earlier = task.details.options ?? [];
  task.details.options = options.map((option) => {
    const seen = earlier.find((item) => item.provider_id === option.provider_id);
    return { ...option, offered_in_message: seen?.offered_in_message ?? run.messageId };
  });
  run.deps.tasks.save(task);
}

// Runs the search for a task, applies the user's limits, stores the options and
// moves the state. Used by the model's tool and by code after a failed booking.
export async function searchForTask(run: Run, task: Task): Promise<SearchOutcome> {
  if (!["COLLECTING", "COMPARING", "NEEDS_USER"].includes(task.state)) run.setState(task, "COMPARING");
  run.setState(task, "SEARCHING");

  const { service, area, date_from: from, date_to: to, provider_id: requestedId } = task.request;
  const result = await run.callMock("search_providers", {
    service: service!, area: area!, date_range: { from: from!, to: to! },
  });
  if (!result.ok) {
    run.setState(task, "COLLECTING", { because: result.error });
    return { kind: "error", error: result.error };
  }

  const refused = task.details.conflict_slots ?? [];
  const providers = result.providers.map((provider) => ({
    ...provider,
    available_slots: provider.available_slots.filter((slot) => !refused.includes(slot)),
  }));
  const { options, removed } = buildOptions(providers, task.request);

  if (requestedId) {
    const requested = options.filter((option) => option.provider_id === requestedId);
    if (requested.length > 0) {
      saveOptions(run, task, requested);
      run.setState(task, "COMPARING");
      return { kind: "options", options: requested, removed };
    }
    // The asked-for provider has nothing that fits. Say so, and do not switch.
    const asked = providers.find((provider) => provider.provider_id === requestedId);
    saveOptions(run, task, []);
    run.setState(task, "COMPARING");
    run.setState(task, "NEEDS_USER", { because: "requested_provider_has_no_fit" });
    return {
      kind: "requested_provider_no_fit",
      name: asked?.name ?? requestedId,
      otherSlots: asked?.available_slots.slice(0, 4) ?? [],
      others: options.filter((option) => option.provider_id !== requestedId),
    };
  }

  saveOptions(run, task, options);
  run.setState(task, "COMPARING");
  if (options.length === 0) {
    run.setState(task, "NEEDS_USER", { because: "no_options_fit" });
    return { kind: "nothing_fits", removed };
  }
  return { kind: "options", options, removed };
}
