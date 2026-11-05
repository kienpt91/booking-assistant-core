import type { Actor } from "../../domain/actor.js";
import { compareCivil, daysBetween } from "../../domain/time/civil.js";
import { DAY, type Instant } from "../../domain/time/instant.js";
import { SlidingWindowLimiter } from "./limits.js";
import { TOOLS, type ToolCall, type ToolName } from "./tools.js";

export interface PolicyConfig {
  /** which tools each kind of actor may call at all. Anything not listed is refused. */
  readonly toolsByRole: Readonly<Record<Actor["kind"], readonly ToolName[]>>;
  /** longest availability search, in days */
  readonly maxRangeDays: number;
  /** a start time further than this many days ahead is refused outright */
  readonly maxHorizonDays: number;
  readonly maxNoteLength: number;
  /** confirmed bookings, moves and cancellations per client in a rolling 24 hours */
  readonly stateChangesPerDay: number;
  /** proposals (each one holds a slot for a few minutes) per client in a rolling 24 hours */
  readonly proposalsPerDay: number;
  /** tool calls per client per minute, whatever they are */
  readonly toolCallsPerMinute: number;
}

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  // the chat assistant only ever acts for a client; staff and system are not served through it
  toolsByRole: { client: ["check_availability", "book", "move", "cancel", "my_appointments"], staff: [], system: [] },
  maxRangeDays: 14,
  maxHorizonDays: 90,
  maxNoteLength: 200,
  stateChangesPerDay: 6,
  proposalsPerDay: 20,
  toolCallsPerMinute: 20,
};

export type PolicyReason =
  | "role_not_allowed"
  | "rate_limited"
  | "range_too_large"
  | "time_out_of_range"
  | "note_too_long"
  | "not_found"
  | "daily_quota"
  | "proposal_quota";

export interface PolicyDecision {
  readonly effect: "allow" | "confirm" | "deny";
  readonly reasons: readonly PolicyReason[];
}

/** What the engine needs to know that is not in the call. The application computes it from the database, never from the model. */
export interface PolicyFacts {
  /** for move and cancel: whether the appointment is one of the acting client's own (a scoped lookup found it) */
  readonly ownsAppointment: boolean | undefined;
  readonly executedToday: number;
  readonly proposedToday: number;
}

export interface PolicyRequest {
  readonly actor: Actor;
  readonly call: ToolCall;
  /** `propose`: the model asked. `execute`: the client confirmed; only the confirmation path uses it. */
  readonly phase: "propose" | "execute";
  readonly now: Instant;
  readonly facts: PolicyFacts;
}

/**
 * The decision about one tool call, made in code the model cannot reach. It reads the actor the transport
 * authenticated, the validated call and facts the application computed; it never reads message text. The rules:
 *   1. role: the tool must be on the allowlist of the actor's role, else deny
 *   2. rate: too many calls in a minute, deny
 *   3. arguments: ranges, horizons and sizes, deny when outside
 *   4. ownership: move and cancel only for an appointment the acting client owns (a stranger's id looks like a missing one)
 *   5. state changes: a daily number of proposals and of executed changes. One proposal per message is structural: the turn loop
 *      (turn.ts) ends at the first proposal, so a message can never lead to more than one change
 *   6. effect: a read is allowed, a state change is never allowed straight from the model: it needs the client's confirmation
 * Every deny carries its reasons; an allow or confirm is only given when there are none.
 */
export class PolicyEngine {
  private readonly config: PolicyConfig;
  private readonly limiter: SlidingWindowLimiter;

  constructor(config: PolicyConfig = DEFAULT_POLICY_CONFIG, limiter?: SlidingWindowLimiter) {
    this.config = config;
    this.limiter = limiter ?? new SlidingWindowLimiter(60_000, config.toolCallsPerMinute);
  }

  evaluate(request: PolicyRequest): PolicyDecision {
    const { actor, call, phase, now, facts } = request;
    if (!this.config.toolsByRole[actor.kind].includes(call.tool)) return deny("role_not_allowed");
    if (phase === "propose" && !this.limiter.hit(actorKey(actor), now)) return deny("rate_limited");

    const reasons: PolicyReason[] = [];
    const config = this.config;
    switch (call.tool) {
      case "check_availability": {
        const to = call.args.date_to ?? call.args.date_from;
        if (compareCivil(call.args.date_from, to) > 0 || daysBetween(call.args.date_from, to) >= config.maxRangeDays) reasons.push("range_too_large");
        break;
      }
      case "book":
        if (!this.withinHorizon(call.args.starts_at, now)) reasons.push("time_out_of_range");
        if ((call.args.notes?.length ?? 0) > config.maxNoteLength) reasons.push("note_too_long");
        break;
      case "move":
        if (!this.withinHorizon(call.args.new_starts_at, now)) reasons.push("time_out_of_range");
        if (facts.ownsAppointment !== true) reasons.push("not_found");
        break;
      case "cancel":
        if (facts.ownsAppointment !== true) reasons.push("not_found");
        break;
      case "my_appointments":
        break;
    }

    if (TOOLS[call.tool].effect === "write") {
      if (phase === "propose" && facts.proposedToday >= config.proposalsPerDay) reasons.push("proposal_quota");
      if (facts.executedToday >= config.stateChangesPerDay) reasons.push("daily_quota");
    }

    if (reasons.length > 0) return { effect: "deny", reasons };
    if (TOOLS[call.tool].effect === "read") return { effect: "allow", reasons: [] };
    return { effect: phase === "propose" ? "confirm" : "allow", reasons: [] };
  }

  private withinHorizon(startsAt: Instant, now: Instant): boolean {
    return startsAt > now && startsAt <= now + this.config.maxHorizonDays * DAY;
  }
}

function deny(reason: PolicyReason): PolicyDecision {
  return { effect: "deny", reasons: [reason] };
}

function actorKey(actor: Actor): string {
  return `${actor.salonId}:${actor.kind === "client" ? actor.clientId : actor.kind === "staff" ? actor.staffId : "system"}`;
}
