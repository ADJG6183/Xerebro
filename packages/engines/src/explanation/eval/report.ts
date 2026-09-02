/**
 * `npm run eval:faithfulness -w @xerebro/engines`
 *
 * Prints the catch rate and every failure. Exits non-zero when an unfaithful
 * explanation is MISSED, so it can gate a release or a provider swap in CI
 * (ADR-002) — the vitest gate covers the same ground for ordinary runs.
 *
 * Deliberately not exported from the package index: this is a dev tool, and
 * the app bundle has no reason to carry the corpus.
 */
import { formatEvalReport, newMisses, runFaithfulnessEval } from "./harness";

const report = runFaithfulnessEval();
console.log(formatEvalReport(report));

// Known gaps are accepted risks, not build failures — otherwise CI stays
// red forever and everyone learns to ignore it. Only a NEW miss fails.
const unexpected = newMisses(report);
if (unexpected.length > 0) {
  console.error(`\n${unexpected.length} NEW unfaithful explanation(s) not caught.`);
  process.exit(1);
}
