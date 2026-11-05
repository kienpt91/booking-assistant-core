import { describe, expect, it } from "vitest";
import { CONNECTION_BUDGET, declarePool, declaredConnections, TRANSIENT_ALLOWANCE } from "../support/connection-budget.js";

describe("the connection budget of the PostgreSQL tests", () => {
  it("fits the default of 100 connections with 3 reserved, with room to spare", () => {
    expect(CONNECTION_BUDGET + 3).toBeLessThanOrEqual(100 - 20);
  });

  it("lets the 50 racing clients and a small second pool share a file, and refuses a second pool of 60", () => {
    const racers = declarePool("racers", 50);
    const small = declarePool("small", 5);
    expect(declaredConnections()).toBe(55);
    expect(() => declarePool("second pool of 60", 60)).toThrow("connection budget exceeded");
    small();
    racers();
    expect(declaredConnections()).toBe(0);
  });

  it("refuses a pool that would take the file past the budget, counting the harness's own connections", () => {
    expect(() => declarePool("too big", CONNECTION_BUDGET - TRANSIENT_ALLOWANCE + 1)).toThrow("connection budget exceeded");
    const exact = declarePool("exact", CONNECTION_BUDGET - TRANSIENT_ALLOWANCE);
    expect(() => declarePool("one more", 1)).toThrow("connection budget exceeded");
    exact();
  });

  it("gives connections back once, however often the release is called", () => {
    const release = declarePool("a", 10);
    release();
    release();
    expect(declaredConnections()).toBe(0);
  });
});
