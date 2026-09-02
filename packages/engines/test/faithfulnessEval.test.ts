/**
 * The eval harness as a launch gate (docs/AIArchitecture.md, ADR-002).
 *
 * The existing faithfulness.test.ts proves the checker's MECHANICS on a few
 * cases. This measures its CATCH RATE over the corpus and fails the build if
 * a fabricated explanation would reach a user — including after a provider
 * or model change.
 */
import { describe, expect, it } from "vitest";
import { EVAL_CORPUS } from "../src/explanation/eval/corpus";
import {
  formatEvalReport,
  KNOWN_GAPS,
  newMisses,
  runFaithfulnessEval,
} from "../src/explanation/eval/harness";

describe("faithfulness eval harness", () => {
  const report = runFaithfulnessEval();

  it("GATE: catches every unfaithful explanation except the known gaps", () => {
    // A NEW miss means an invented figure reaches a user. Non-negotiable.
    expect(newMisses(report), `NEW misses:\n${formatEvalReport(report)}`).toEqual([]);
  });

  it("GATE: every known gap is still a gap (delete it here once fixed)", () => {
    // Guards against the list going stale: a gap that starts being caught
    // must be removed from KNOWN_GAPS, which is how a fix gets proven.
    const missed = report.failures.filter((f) => f.kind === "missed").map((f) => f.id);
    const fixed = KNOWN_GAPS.filter((id) => !missed.includes(id));
    expect(fixed, `now caught — remove from KNOWN_GAPS: ${fixed.join(", ")}`).toEqual([]);
  });

  it("reports the real catch rate, gaps included", () => {
    // The honest number. It is NOT 100%, and the report says so out loud
    // rather than hiding behind a corpus tuned to what we already catch.
    expect(report.caughtRate).toBeGreaterThanOrEqual(0.8);
    expect(report.caughtRate).toBeLessThan(1); // honest: 2 known gaps remain
  });

  it("GATE: does not reject faithful explanations", () => {
    // False positives are SAFE (the template ships) but degrade quality,
    // so they are a budget, not a hard failure at zero.
    expect(report.falsePositiveRate, formatEvalReport(report)).toBeLessThanOrEqual(0.2);
  });

  it("the corpus covers both classes and every verdict", () => {
    // Guards the metric itself: an all-faithful corpus would score a
    // meaningless 100% catch rate.
    expect(EVAL_CORPUS.some((c) => c.faithful)).toBe(true);
    expect(EVAL_CORPUS.some((c) => !c.faithful)).toBe(true);
    const verdicts = new Set(EVAL_CORPUS.map((c) => c.decision.decision));
    expect([...verdicts].sort()).toEqual(["approve", "caution", "decline"]);
  });

  it("scores a deliberately broken checker as failing (the metric works)", () => {
    // If runFaithfulnessEval always reported 100%, the gates above would be
    // decoration. Feed it a corpus whose labels are inverted: a checker that
    // is right must then score as wrong.
    const inverted = EVAL_CORPUS.map((c) => ({ ...c, faithful: !c.faithful }));
    expect(runFaithfulnessEval(inverted).caughtRate).toBeLessThan(1);
  });

  it("reports empty classes without dividing by zero", () => {
    const empty = runFaithfulnessEval([]);
    expect(empty).toMatchObject({ total: 0, caughtRate: 1, falsePositiveRate: 0 });
  });
});
