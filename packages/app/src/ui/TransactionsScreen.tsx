/**
 * Transactions per docs/uiDesign/image2.png screen 2: All/Income/Expense
 * filter chips, day-grouped rows (Today / Yesterday / date).
 */
import { useMemo, useState } from "react";
import { Pressable, SectionList, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { DashboardViewModel } from "../data/dashboardModel";
import { TxnRow } from "./bits";
import { theme } from "./theme";

type Filter = "all" | "income" | "expense";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "income", label: "Income" },
  { key: "expense", label: "Expense" },
];

export function TransactionsScreen({ vm, onAdd }: { vm: DashboardViewModel; onAdd: () => void }) {
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
      <View style={styles.header}>
        <View style={styles.headerSpacer} />
        <Text style={styles.title}>Transactions</Text>
        <Pressable style={styles.addBtn} onPress={onAdd} hitSlop={8}>
          <Ionicons name="add" size={22} color={theme.primary} />
        </Pressable>
      </View>
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
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  headerSpacer: { width: 34 },
  title: { fontSize: 20, fontWeight: "800", color: theme.ink, textAlign: "center" },
  addBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: theme.chipBg,
    alignItems: "center",
    justifyContent: "center",
  },
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
