/**
 * "Can I buy this?" — the screen the mockups never designed (flagged in
 * V1Scope.md). Visual language follows docs/uiDesign/image2.png; the states
 * come from the doctrine: a verified verdict, or an honest CANT_VERIFY /
 * NEEDS_USER_INPUT card that shows data age and never fabricates certainty.
 */
import { Ionicons } from "@expo/vector-icons";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { EnhancedExplanation, PurchaseCheckResult } from "../data/decisionFlow";
import { theme } from "./theme";

const VERDICT: Record<string, { label: string; color: string; icon: keyof typeof Ionicons.glyphMap }> = {
  approve: { label: "You can afford this", color: theme.primaryDark, icon: "checkmark-circle" },
  caution: { label: "Doable, but tight", color: theme.amber, icon: "alert-circle" },
  decline: { label: "I'd hold off", color: theme.outflow, icon: "close-circle" },
};

export function AskScreen(props: {
  amountText: string;
  onAmountText: (t: string) => void;
  descriptionText: string;
  onDescriptionText: (t: string) => void;
  checking: boolean;
  onCheck: () => void;
  onBack: () => void;
  answer: PurchaseCheckResult | null;
  enhanced: EnhancedExplanation | null;
  feedbackSent: boolean;
  onFeedback: (r: "accepted" | "ignored") => void;
}) {
  const { answer } = props;
  const verification = answer?.record.verification;
  const decision = answer?.record.decision;
  const verdict =
    verification?.status === "VERIFIED" && decision
      ? VERDICT[decision.decision]
      : verification
        ? { label: "Can't verify right now", color: theme.slate, icon: "help-circle" as const }
        : null;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Pressable onPress={props.onBack} style={styles.backRow}>
        <Ionicons name="chevron-back" size={18} color={theme.primary} />
        <Text style={styles.back}>Dashboard</Text>
      </Pressable>
      <Text style={styles.title}>Can I buy this?</Text>
      <Text style={styles.subtitle}>Checked against your verified balances — never a guess.</Text>

      <View style={styles.askCard}>
        <Text style={styles.dollar}>$</Text>
        <TextInput
          style={styles.amountInput}
          value={props.amountText}
          onChangeText={props.onAmountText}
          placeholder="600"
          placeholderTextColor={theme.faint}
          keyboardType="decimal-pad"
          editable={!props.checking}
        />
        <Pressable style={styles.checkBtn} onPress={props.onCheck} disabled={props.checking}>
          <Text style={styles.checkText}>{props.checking ? "Checking…" : "Check"}</Text>
        </Pressable>
      </View>

      <View style={styles.descCard}>
        <Ionicons name="pricetag-outline" size={16} color={theme.faint} />
        <TextInput
          style={styles.descInput}
          value={props.descriptionText}
          onChangeText={props.onDescriptionText}
          placeholder="What is it? (optional — e.g. espresso machine)"
          placeholderTextColor={theme.faint}
          editable={!props.checking}
          maxLength={120}
        />
      </View>

      {answer && verdict && decision && verification && (
        <View style={styles.answerCard}>
          <View style={styles.verdictRow}>
            <Ionicons name={verdict.icon} size={26} color={verdict.color} />
            <Text style={[styles.verdict, { color: verdict.color }]}>{verdict.label}</Text>
          </View>
          <Text style={styles.explanation}>{props.enhanced?.text ?? answer.explanation}</Text>
          {props.enhanced && (
            <View style={styles.aiTag}>
              <Ionicons name="sparkles" size={11} color={theme.primaryDeep} />
              <Text style={styles.aiTagText}>AI explanation · verified against the decision</Text>
            </View>
          )}

          <View style={styles.metaCard}>
            <Text style={styles.metaLine}>
              Confidence {Math.round(verification.confidence * 100)}% · data{" "}
              {verification.dataAgeSeconds < 3600
                ? "current"
                : `${Math.floor(verification.dataAgeSeconds / 3600)}h old`}
            </Text>
            {answer.manualDataOnly && (
              <Text style={styles.metaLine}>Based on your manually entered data</Text>
            )}
            {/* The audit record is always just "queued" the instant this
                renders (decisionFlow.ts intentionally returns before the
                upload is even attempted, so the decision never waits on
                network) — that is normal, not a warning. Use the real
                offline signal (from the pull/refresh legs) to decide
                whether this needs the cautionary phrasing and color. */}
            <Text style={[styles.metaLine, answer.offline && { color: theme.amber }]}>
              {answer.offline
                ? "Saved on this device — syncs when you're back online"
                : "Saved — uploading in the background"}
            </Text>
            {answer.aggregatorFailure && (
              // Why the bank data may be stale, in words the user can act on
              // (docs/Reliability.md) — never a silent failure.
              <Text style={[styles.metaLine, { color: theme.amber }]}>
                {answer.aggregatorFailure.userMessage}
                {answer.aggregatorFailure.needsUserAction ? " Reconnect it from the Add screen." : ""}
              </Text>
            )}
          </View>

          <Text style={styles.whyTitle}>Why</Text>
          {decision.tradeoffs.map((t) => (
            <Text key={t.code} style={styles.why}>
              • {t.detail}
            </Text>
          ))}
          <Text style={styles.rules}>
            Rules: {decision.rulesFired.join(", ")} ({decision.rulesVersion})
          </Text>

          {!props.feedbackSent ? (
            <View style={styles.feedbackRow}>
              <Pressable style={styles.feedbackBtn} onPress={() => props.onFeedback("accepted")}>
                <Text style={styles.feedbackText}>Helpful</Text>
              </Pressable>
              <Pressable style={styles.feedbackBtn} onPress={() => props.onFeedback("ignored")}>
                <Text style={styles.feedbackText}>Not helpful</Text>
              </Pressable>
            </View>
          ) : (
            <Text style={styles.thanks}>Thanks — noted.</Text>
          )}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  content: { paddingTop: 72, paddingHorizontal: 20, paddingBottom: 32 },
  backRow: { flexDirection: "row", alignItems: "center", marginBottom: 10 },
  back: { color: theme.primary, fontSize: 15, fontWeight: "600" },
  title: { fontSize: 22, fontWeight: "800", color: theme.ink },
  subtitle: { fontSize: 13, color: theme.slate, marginTop: 2, marginBottom: 16 },
  askCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.card,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
  },
  dollar: { fontSize: 26, fontWeight: "800", color: theme.ink, marginRight: 6 },
  amountInput: { flex: 1, fontSize: 26, fontWeight: "800", color: theme.ink, paddingVertical: 2 },
  checkBtn: {
    backgroundColor: theme.primary,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 18,
  },
  checkText: { color: theme.onPrimary, fontWeight: "700" },
  descCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: theme.card,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginTop: -6,
    marginBottom: 16,
  },
  descInput: { flex: 1, fontSize: 14, color: theme.ink, paddingVertical: 2 },
  answerCard: { backgroundColor: theme.card, borderRadius: 16, padding: 18 },
  verdictRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 },
  verdict: { fontSize: 18, fontWeight: "800" },
  explanation: { fontSize: 15, color: theme.ink, lineHeight: 22 },
  aiTag: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 8 },
  aiTagText: { fontSize: 11, color: theme.primaryDeep },
  metaCard: {
    backgroundColor: theme.bg,
    borderRadius: 10,
    padding: 10,
    marginTop: 12,
  },
  metaLine: { color: theme.slate, fontSize: 12, lineHeight: 18 },
  whyTitle: { fontSize: 14, fontWeight: "700", color: theme.ink, marginTop: 14, marginBottom: 6 },
  why: { fontSize: 13, color: theme.ink, lineHeight: 19, marginBottom: 4 },
  rules: { color: theme.faint, fontSize: 11, marginTop: 6 },
  feedbackRow: { flexDirection: "row", gap: 10, marginTop: 14 },
  feedbackBtn: {
    borderWidth: 1,
    borderColor: theme.primary,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  feedbackText: { color: theme.primaryDark, fontWeight: "700" },
  thanks: { color: theme.slate, fontSize: 13, marginTop: 12 },
});
