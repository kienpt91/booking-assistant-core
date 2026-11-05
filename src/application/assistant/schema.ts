import { parseUuid } from "../../domain/ids.js";
import { err, ok, type Result } from "../../domain/result.js";
import { parseCivilDate, type CivilDate } from "../../domain/time/civil.js";
import type { Instant } from "../../domain/time/instant.js";

/**
 * A small strict validator for what the model sends as tool arguments (no dependency: the shapes are few). It accepts
 * a plain object whose keys are all declared, and fields of exactly the declared type. Everything else is refused, and an
 * issue names the field and the kind of problem, never the value, so it can be logged and shown to the model safely.
 */
export interface Issue {
  readonly field: string;
  readonly problem: "required" | "unknown_field" | "wrong_type" | "invalid" | "too_long" | "out_of_range";
}

export interface Field<T> {
  /** how the model is told to write it */
  readonly describe: string;
  readonly optional: boolean;
  parse(value: unknown): Result<T, Issue["problem"]>;
}

const CONTROL = /[\p{Cc}\p{Cf}]/u;
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,3})?)?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/;

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

export const field = {
  uuid(describe = "a UUID"): Field<string> {
    return {
      describe,
      optional: false,
      parse: (v) => {
        if (typeof v !== "string") return err("wrong_type");
        const id = parseUuid(v);
        return id === undefined ? err("invalid") : ok(id);
      },
    };
  },
  date(describe = "a date, YYYY-MM-DD"): Field<CivilDate> {
    return {
      describe,
      optional: false,
      parse: (v) => {
        if (typeof v !== "string") return err("wrong_type");
        const date = parseCivilDate(v);
        return date ? ok(date) : err("invalid");
      },
    };
  },
  /** ISO 8601 date and time with an explicit offset ("2026-11-10T10:00:00+00:00"), the form the availability tool returns. */
  instant(describe = "a date and time with offset, ISO 8601"): Field<Instant> {
    return {
      describe,
      optional: false,
      parse: (v) => {
        if (typeof v !== "string") return err("wrong_type");
        const match = INSTANT.exec(v);
        // Date.parse rolls 2026-02-30 over to March 2: the calendar date is checked on its own first
        if (!match || !parseCivilDate(`${match[1]}-${match[2]}-${match[3]}`)) return err("invalid");
        const at = Date.parse(v);
        return Number.isFinite(at) ? ok(at) : err("invalid");
      },
    };
  },
  text(max: number, describe = `text, at most ${max} characters`): Field<string> {
    return {
      describe,
      optional: false,
      parse: (v) => {
        if (typeof v !== "string") return err("wrong_type");
        if (v.length > max) return err("too_long");
        return CONTROL.test(v) ? err("invalid") : ok(v);
      },
    };
  },
  optional<T>(inner: Field<T>): Field<T | undefined> {
    return { describe: `optional: ${inner.describe}`, optional: true, parse: (v) => (v === undefined ? ok(undefined) : inner.parse(v)) };
  },
};

export type Infer<S> = S extends Field<infer T> ? T : never;
export type Shape = Readonly<Record<string, Field<unknown>>>;
export type Parsed<S extends Shape> = { readonly [K in keyof S]: Infer<S[K]> };

export interface Schema<S extends Shape> {
  readonly shape: S;
  parse(input: unknown): Result<Parsed<S>, Issue[]>;
}

export function object<S extends Shape>(shape: S): Schema<S> {
  return {
    shape,
    parse(input) {
      if (typeof input !== "object" || input === null || Array.isArray(input)) return err([{ field: "(arguments)", problem: "wrong_type" }]);
      const proto = Object.getPrototypeOf(input);
      if (proto !== Object.prototype && proto !== null) return err([{ field: "(arguments)", problem: "wrong_type" }]);
      const record = input as Record<string, unknown>;
      const issues: Issue[] = [];
      for (const key of Object.keys(record)) {
        if (!Object.hasOwn(shape, key)) issues.push({ field: SAFE_NAME.test(key) ? key : "(invalid name)", problem: "unknown_field" });
      }
      const out: Record<string, unknown> = {};
      for (const [name, f] of Object.entries(shape)) {
        const value = Object.hasOwn(record, name) ? record[name] : undefined;
        if (value === undefined) {
          if (!f.optional) issues.push({ field: name, problem: "required" });
          continue;
        }
        const parsed = f.parse(value);
        if (parsed.ok) out[name] = parsed.value;
        else issues.push({ field: name, problem: parsed.error });
      }
      return issues.length > 0 ? err(issues) : ok(out as Parsed<S>);
    },
  };
}
