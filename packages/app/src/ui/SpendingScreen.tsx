/**
 * Spending (docs/rocketMoneyMvpSpec.md §6): month selector, total eligible
 * spending, category breakdown, and a filterable/searchable transaction
 * list over complete local history — evolved from the old Transactions tab
 * (§12: "Transactions tab -> Spending", approved 2026-10-07).
 *
 * Account and pending/posted filters are supported by the view-model
 * (spendingModel.ts) but have no dedicated control here yet — direction
 * (all/income/expense), category (tap a breakdown row), and search are the
 * ones wired up in this pass.
 */
import { useMemo, useState } from "react";
import { Pressable, SectionList, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { ProjectionSnapshot } from "@xerebro/engines";
import { buildSpendingViewModel, type SpendingFilters } from "../data/spendingModel";
import { TxnRow } from "./bits";
import { humanizeCategory } from "./categoryDisplay";
import { theme } from "./theme";

type Direction = "all" | "income" | "expense";
const DIRECTIONS: { key: Direction; label: string }[] = [
  { key: "all", label: "All" },
  { key: "income", label: "Income" },
  { key: "expense", label: "Expense" },
];

function monthLabel(month: string): string {
  return new Date(`${month}-01T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function shiftMonth(month: string, delta: number): string {
  const d = new Date(`${month}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return d.toISOString().slice(0, 7);
}

export function SpendingScreen({
  snapshot,
  todayLocal,
  onAdd,
  onOpenTxn,
  initialCategory,
}: {
  snapshot: ProjectionSnapshot;
  todayLocal: string;
  onAdd: () => void;
  onOpenTxn: (txnId: string) => void;
  /** Set when arriving from Budget's "open scoped spending" (spec §6). Only
   * used as this screen's OWN state's initial value — a fresh mount (tab
   * switches unmount/remount this screen) is what makes a new value here
   * take effect, not a prop-change while already mounted. */
  initialCategory?: string;
}) {
  const [month, setMonth] = useState(todayLocal.slice(0, 7));
  const [direction, setDirection] = useState<Direction>("all");
  const [category, setCategory] = useState<string | undefined>(initialCategory);
  const [search, setSearch] = useState("");

  const filters: SpendingFilters = {
    ...(direction !== "all" ? { direction } : {}),
    ...(category ? { category } : {}),
    ...(search.trim() ? { search: search.trim() } : {}),
  };

  const vm = useMemo(
    () => buildSpendingViewModel(snapshot, { month, todayLocal, filters }),
    // filters is a fresh object each render; compare by its actual inputs.
    [snapshot, month, todayLocal, direction, category, search],
  );

  const sections = vm.groups.map((g) => ({ title: g.label, data: g.items }));

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.headerSpacer} />
        <Text style={styles.title}>Spending</Text>
        <Pressable style={styles.addBtn} onPress={onAdd} hitSlop={8}>
          <Ionicons name="add" size={22} color={theme.primary} />
        </Pressable>
      </View>

      <View style={styles.monthRow}>
        <Pressable onPress={() => setMonth((m) => shiftMonth(m, -1))} hitSlop={12}>
          <Ionicons name="chevron-back" size={20} color={theme.ink} />
        </Pressable>
        <Text style={styles.monthLabel}>{monthLabel(month)}</Text>
        <Pressable onPress={() => setMonth((m) => shiftMonth(m, 1))} hitSlop={12}>
          <Ionicons name="chevron-forward" size={20} color={theme.ink} />
        </Pressable>
      </View>

      <View style={styles.totalCard}>
        <Text style={styles.totalLabel}>
          {vm.searchingAllHistory ? "Matching your search" : "Eligible spending"}
        </Text>
        <Text style={styles.totalValue}>{vm.totalSpentFormatted}</Text>
        {vm.pendingSpentMinor > 0 && (
          <Text style={styles.pendingNote}>+ {vm.pendingSpentFormatted} pending, not yet settled</Text>
        )}
      </View>

      {!vm.searchingAllHistory && vm.categories.length > 0 && (
        <View style={styles.categoryRow}>
          {category && (
            <Pressable style={styles.categoryClear} onPress={() => setCategory(undefined)}>
              <Text style={styles.categoryClearText}>{humanizeCategory(category)} ✕</Text>
            </Pressable>
          )}
          {!category &&
            vm.categories.slice(0, 6).map((c) => (
              <Pressable key={c.category} style={styles.categoryChip} onPress={() => setCategory(c.category)}>
                <Text style={styles.categoryChipText}>{humanizeCategory(c.category)}</Text>
                <Text style={styles.categoryChipAmount}>{c.totalFormatted}</Text>
              </Pressable>
            ))}
        </View>
      )}

      <View style={styles.searchRow}>
        <Ionicons name="search" size={16} color={theme.faint} />
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Search merchant or description"
          placeholderTextColor={theme.faint}
        />
      </View>

      <View style={styles.chips}>
        {DIRECTIONS.map((d) => (
          <Pressable
            key={d.key}
            style={[styles.chip, direction === d.key && styles.chipActive]}
            onPress={() => setDirection(d.key)}
          >
            <Text style={[styles.chipText, direction === d.key && styles.chipTextActive]}>{d.label}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={styles.resultCount} accessibilityLiveRegion="polite">
        {vm.resultCount === 0
          ? "No transactions"
          : vm.shownCount < vm.resultCount
            ? `Showing ${vm.shownCount} of ${vm.resultCount}`
            : `${vm.resultCount} transaction${vm.resultCount === 1 ? "" : "s"}`}
      </Text>

      <SectionList
        sections={sections}
        keyExtractor={(t) => t.txnId}
        renderSectionHeader={({ section }) => <Text style={styles.groupLabel}>{section.title}</Text>}
        renderItem={({ item }) => <TxnRow txn={item} onPress={onOpenTxn} />}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {vm.searchingAllHistory ? "No matches in your history." : "No transactions this month."}
          </Text>
        }
        stickySectionHeadersEnabled={false}
        contentContainerStyle={styles.listContent}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg, paddingTop: 72, paddingHorizontal: 20 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
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
  monthRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    marginBottom: 12,
  },
  monthLabel: { fontSize: 15, fontWeight: "700", color: theme.ink, minWidth: 140, textAlign: "center" },
  totalCard: { backgroundColor: theme.card, borderRadius: 14, padding: 16, marginBottom: 12 },
  totalLabel: { fontSize: 12, color: theme.slate },
  totalValue: { fontSize: 26, fontWeight: "800", color: theme.ink, marginTop: 2 },
  pendingNote: { fontSize: 12, color: theme.amber, marginTop: 6 },
  categoryRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  categoryChip: {
    backgroundColor: theme.card,
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  categoryChipText: { fontSize: 12, fontWeight: "600", color: theme.ink },
  categoryChipAmount: { fontSize: 11, color: theme.slate, marginTop: 2 },
  categoryClear: {
    backgroundColor: theme.primary,
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  categoryClearText: { fontSize: 12, fontWeight: "700", color: theme.onPrimary },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: theme.card,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 10,
  },
  searchInput: { flex: 1, fontSize: 14, color: theme.ink },
  chips: { flexDirection: "row", gap: 8, marginBottom: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 18, borderRadius: 20, backgroundColor: theme.chipBg },
  chipActive: { backgroundColor: theme.primary },
  chipText: { fontSize: 13, color: theme.slate, fontWeight: "600" },
  chipTextActive: { color: theme.onPrimary },
  resultCount: { fontSize: 12, color: theme.slate, marginBottom: 4 },
  groupLabel: { fontSize: 13, fontWeight: "700", color: theme.slate, marginTop: 14, marginBottom: 4 },
  empty: { color: theme.slate, marginTop: 24, textAlign: "center" },
  listContent: { paddingBottom: 24 },
});
