/**
 * Transactions per docs/uiDesign/image2.png screen 2: All/Income/Expense
 * filter chips, day-grouped rows (Today / Yesterday / date).
 */
import { useMemo, useState } from "react";
import { Pressable, SectionList, StyleSheet, Text, View } from "react-native";
import type { DashboardViewModel } from "../data/dashboardModel";
import { TxnRow } from "./bits";
import { theme } from "./theme";

type Filter = "all" | "income" | "expense";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "income", label: "Income" },
  { key: "expense", label: "Expense" },
];

export function TransactionsScreen({ vm }: { vm: DashboardViewModel }) {
  const [filter, setFilter] = useState<Filter>("all");

  const sections = useMemo(
    () =>
      vm.transactionGroups
        .map((g) => ({
          title: g.label,
          data: g.items.filter(
            (t) =>
              filter === "all" || (filter === "income" ? t.isInflow : !t.isInflow),
          ),
        }))
        .filter((s) => s.data.length > 0),
    [vm.transactionGroups, filter],
  );

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Transactions</Text>
      <View style={styles.chips}>
        {FILTERS.map((f) => (
          <Pressable
            key={f.key}
            style={[styles.chip, filter === f.key && styles.chipActive]}
            onPress={() => setFilter(f.key)}
          >
            <Text style={[styles.chipText, filter === f.key && styles.chipTextActive]}>
              {f.label}
            </Text>
          </Pressable>
        ))}
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(t) => t.txnId}
        renderSectionHeader={({ section }) => (
          <Text style={styles.groupLabel}>{section.title}</Text>
        )}
        renderItem={({ item }) => <TxnRow txn={item} />}
        ListEmptyComponent={<Text style={styles.empty}>No transactions yet.</Text>}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={styles.listContent}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg, paddingTop: 72, paddingHorizontal: 20 },
  title: { fontSize: 20, fontWeight: "800", color: theme.ink, marginBottom: 14, textAlign: "center" },
  chips: { flexDirection: "row", gap: 8, marginBottom: 8 },
  chip: {
    paddingVertical: 8,
    paddingHorizontal: 18,
    borderRadius: 20,
    backgroundColor: theme.chipBg,
  },
  chipActive: { backgroundColor: theme.primary },
  chipText: { fontSize: 13, color: theme.slate, fontWeight: "600" },
  chipTextActive: { color: theme.onPrimary },
  groupLabel: { fontSize: 13, fontWeight: "700", color: theme.slate, marginTop: 14, marginBottom: 4 },
  empty: { color: theme.slate, marginTop: 24, textAlign: "center" },
  listContent: { paddingBottom: 24 },
});
