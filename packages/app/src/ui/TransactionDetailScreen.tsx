/**
 * Transaction detail (docs/rocketMoneyMvpSpec.md §6 Spending): amount/
 * currency, account, dates, status, effective category, notes, and any
 * history-exclusion reason. Category/note corrections post an append-only
 * TransactionAnnotated overlay (userEvents.ts) — the source transaction is
 * never edited, and the raw bank description always stays visible.
 */
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { TransactionDetail } from "../data/transactionDetailModel";
import { humanizeCategory } from "./categoryDisplay";
import { LabeledInput, PrimaryButton } from "./forms";
import { theme } from "./theme";

export function TransactionDetailScreen(props: {
  detail: TransactionDetail;
  onBack: () => void;
  onSave: (edit: { categoryOverride?: string; note?: string }) => void;
  saving?: boolean;
}) {
  const { detail } = props;
  const [category, setCategory] = useState(detail.category ?? "");
  const [note, setNote] = useState(detail.note ?? "");
  // A cleared field is never treated as a change: TransactionAnnotatedPayload
  // has no "remove this override" sentinel, and an omitted key MERGES over
  // the existing annotation rather than clearing it (see onSave below) — so
  // typing a field down to empty must not look like a saved edit it isn't.
  const categoryChanged = category.trim() !== "" && category.trim() !== (detail.category ?? "");
  const noteChanged = note.trim() !== "" && note.trim() !== (detail.note ?? "");
  const dirty = categoryChanged || noteChanged;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Pressable onPress={props.onBack} hitSlop={12}>
          <Ionicons name="chevron-back" size={24} color={theme.ink} />
        </Pressable>
        <Text style={styles.title}>Transaction</Text>
        <View style={{ width: 24 }} />
      </View>

      <Text style={styles.merchant}>{detail.merchant}</Text>
      <Text style={[styles.amount, { color: detail.isInflow ? theme.inflow : theme.outflow }]}>
        {detail.amountFormatted}
      </Text>

      {detail.removed && (
        <Banner tone="warning">
          Removed by your bank{detail.removedReason ? `: ${detail.removedReason}` : "."} Kept
          here for the record.
        </Banner>
      )}
      {detail.historyExclusionReason && <Banner tone="warning">{detail.historyExclusionReason}</Banner>}

      <View style={styles.card}>
        <Row label="Account" value={detail.accountName} />
        <Row label="Status" value={detail.status === "pending" ? "Pending" : "Posted"} />
        {detail.postedDate && <Row label="Posted" value={detail.postedDate} />}
        {detail.authorizedDate && detail.authorizedDate !== detail.postedDate && (
          <Row label="Authorized" value={detail.authorizedDate} />
        )}
        <Row label="Currency" value={detail.currency} />
        <Row label="Bank description" value={detail.merchantRaw} last />
      </View>

      <Text style={styles.sectionLabel}>Your correction</Text>
      <LabeledInput
        label="Category"
        value={category}
        onChangeText={setCategory}
        placeholder={detail.category ? humanizeCategory(detail.category) : "Uncategorized"}
      />
      <LabeledInput label="Note" value={note} onChangeText={setNote} placeholder="Add a note" />
      <PrimaryButton
        label={props.saving ? "Saving…" : "Save"}
        disabled={!dirty || props.saving}
        onPress={() =>
          props.onSave({
            ...(categoryChanged ? { categoryOverride: category.trim() } : {}),
            ...(noteChanged ? { note: note.trim() } : {}),
          })
        }
      />
    </ScrollView>
  );
}

function Row({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <View style={[styles.row, !last && styles.rowDivider]}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function Banner({ tone, children }: { tone: "warning"; children: string }) {
  return (
    <View style={[styles.banner, tone === "warning" && styles.bannerWarning]}>
      <Ionicons name="alert-circle-outline" size={16} color={theme.amber} />
      <Text style={styles.bannerText}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  content: { paddingTop: 72, paddingHorizontal: 20, paddingBottom: 40 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 18,
  },
  title: { fontSize: 20, fontWeight: "800", color: theme.ink },
  merchant: { fontSize: 18, fontWeight: "700", color: theme.ink, textAlign: "center" },
  amount: { fontSize: 32, fontWeight: "800", textAlign: "center", marginTop: 4, marginBottom: 16 },
  banner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    backgroundColor: "#fffbeb",
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  bannerWarning: { borderWidth: 1, borderColor: "#fde68a" },
  bannerText: { flex: 1, fontSize: 13, color: theme.amber, lineHeight: 18 },
  card: {
    backgroundColor: theme.card,
    borderRadius: 14,
    paddingHorizontal: 14,
    marginBottom: 20,
  },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 12 },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: theme.divider },
  rowLabel: { fontSize: 13, color: theme.slate },
  rowValue: { fontSize: 13, color: theme.ink, fontWeight: "600", flexShrink: 1, textAlign: "right" },
  sectionLabel: { fontSize: 13, fontWeight: "700", color: theme.slate, marginBottom: 10 },
});
