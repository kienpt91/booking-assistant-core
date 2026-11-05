import { describe, expect, it } from "vitest";
import { runHostileSuite } from "../../src/demo/hostile.js";
import { leakyHostileEnvironment, memoryHostileEnvironment } from "../support/hostile-env.js";

describe("the hostile conversation suite, on the in-memory double", () => {
  it("holds for every scenario, each with evidence", async () => {
    const results = await runHostileSuite(memoryHostileEnvironment());
    expect(results.map((r) => r.id)).toEqual([
      "cancel-everyone",
      "cancel-by-guessed-id",
      "i-am-the-owner",
      "identity-argument",
      "previous-client-number",
      "injection-in-name",
      "injection-in-notes",
      "arabic-owner-claim",
      "unicode-tricks",
      "fake-confirmation",
      "unknown-tools",
      "other-salon",
      "flood",
      "daily-limit",
      "bulk-in-one-message",
      "tampered-proposal",
    ]);
    for (const r of results) {
      expect({ id: r.id, failures: r.failures, skipped: r.skipped }).toEqual({ id: r.id, failures: [], skipped: false });
      expect(r.held).toBe(true);
      expect(r.evidence.length).toBeGreaterThan(0);
    }
  });
});

describe("the suite itself", () => {
  it("notices when client isolation is missing (negative control)", async () => {
    const results = await runHostileSuite(leakyHostileEnvironment());
    const broken = results.filter((r) => !r.held).map((r) => r.id);
    expect(broken.length).toBeGreaterThan(0);
    expect(broken).toContain("cancel-by-guessed-id");
  });
});
