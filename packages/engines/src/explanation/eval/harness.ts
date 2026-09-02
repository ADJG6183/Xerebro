/**
 * Offline faithfulness eval (docs/AIArchitecture.md): scores the REAL
 * checkFaithfulness against a labelled corpus and reports what it catches.
 *
 * Distinct from the per-call runtime check, which asks "is THIS response
 * safe?". This asks "how good is our leash?" — the question that gates
 * launch and any provider/model change (ADR-002).
 *
 * It measures the checker; it never reimplements it. Two rates matter and
 * they trade off:
 *   - caughtRate: of the unfaithful cases, how many were rejected.
 *     A miss ships a fabricated number to a user. This is the safety number.
 *   - falsePositiveRate: of the faithful cases, how many were wrongly
 *     rejected. Costly but SAFE — the template ships instead (Reliability.md),
 *     so the user still gets a correct answer, just a blander one.
 */
import { checkFaithfulness } from "../faithfulness";
import { EVAL_CORPUS, type EvalCase } from "./corpus";

export interface EvalFailure {
  id: string;
  note: string;
  /** "missed" = unfaithful text accepted (dangerous). */
  kind: "missed" | "false-positive";
}

export interface EvalReport {
  total: number;
  /** Unfaithful cases correctly rejected ÷ unfaithful cases. 1 = caught all. */
  caughtRate: number;
  /** Faithful cases wrongly rejected ÷ faithful cases. 0 = no false alarms. */
  falsePositiveRate: number;
  /** Every case whose outcome disagreed with its label. */
  failures: EvalFailure[];
}

/**
 * Misses we have accepted for now, by case id. Both need the model to
 * volunteer information the prompt never supplies — a number with no
 * currency symbol, or a statistic like "47% of your income". The prompt
 * carries only the decision payload, and the verdict rules still catch the
 * dangerous inversions, so these are tolerated — real gaps, not safe ones.
 * Shared with the vitest gate so the script and the test can never disagree.
 * Removing an id here is how a fix gets proven (the gate then requires it
 * to actually be caught).
 */
export const KNOWN_GAPS: readonly string[] = ["gap/bare-number", "gap/invented-percentage"];

/** Misses that are NOT accepted — the number that should fail a build. */
export function newMisses(report: EvalReport): EvalFailure[] {
  return report.failures.filter((f) => f.kind === "missed" && !KNOWN_GAPS.includes(f.id));
}

export function runFaithfulnessEval(corpus: readonly EvalCase[] = EVAL_CORPUS): EvalReport {
  const failures: EvalFailure[] = [];
  let unfaithful = 0;
  let caught = 0;
  let faithful = 0;
  let falsePositives = 0;

  for (const c of corpus) {
    const accepted = checkFaithfulness(c.text, c.decision).faithful;
    if (c.faithful) {
      faithful++;
      if (!accepted) {
        falsePositives++;
        failures.push({ id: c.id, note: c.note, kind: "false-positive" });
      }
    } else {
      unfaithful++;
      if (accepted) failures.push({ id: c.id, note: c.note, kind: "missed" });
      else caught++;
    }
  }

  return {
    total: corpus.length,
    // An empty class scores as perfect: nothing to catch, nothing missed.
    caughtRate: unfaithful === 0 ? 1 : caught / unfaithful,
    falsePositiveRate: faithful === 0 ? 0 : falsePositives / faithful,
    failures,
  };
}

/** Human-readable report — what a launch or model-swap decision reads. */
export function formatEvalReport(report: EvalReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines = [
    `faithfulness eval: ${report.total} cases`,
    `  caught:          ${pct(report.caughtRate)} of unfaithful explanations`,
    `  false positives: ${pct(report.falsePositiveRate)} of faithful explanations`,
  ];
  for (const f of report.failures) {
    lines.push(`  ${f.kind === "missed" ? "MISSED" : "false positive"}: ${f.id} — ${f.note}`);
  }
  return lines.join("\n");
}
