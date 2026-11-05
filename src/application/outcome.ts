import { BookingError, type BookingErrorCode } from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";

/** What a use case returns for an outcome the caller has to handle: a value, or the refusal with its code. */
export type Outcome<T> = Result<T, BookingError>;

export function succeed<T>(value: T): Outcome<T> {
  return ok(value);
}

export function refuse<T = never>(code: BookingErrorCode): Outcome<T> {
  return err(new BookingError(code));
}
