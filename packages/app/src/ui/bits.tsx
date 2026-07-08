/**
 * Shared UI atoms matching docs/uiDesign/image2.png: category icon chips,
 * transaction rows, stat tiles. Ionicons ships inside the expo package —
 * no added dependency.
 */
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";
import type { DashboardTxn } from "../data/dashboardModel";
import { theme } from "./theme";

type IconName = keyof typeof Ionicons.glyphMap;

const CATEGORY_ICONS: Record<string, { icon: IconName; bg: string; fg: string }> = {
  groceries: { icon: "cart", bg: "#dcfce7", fg: theme.primaryDark },
  income: { icon: "briefcase", bg: "#d1fae5", fg: theme.primaryDeep },
  housing: { icon: "home", bg: "#e0f2fe", fg: "#0369a1" },
  entertainment: { icon: "tv", bg: "#fee2e2", fg: "#b91c1c" },
  transport: { icon: "car", bg: "#ede9fe", fg: "#6d28d9" },
  utilities: { icon: "flash", bg: "#fef3c7", fg: theme.amber },
  shopping: { icon: "bag-handle", bg: "#ffedd5", fg: "#c2410c" },
  "food & drinks": { icon: "restaurant", bg: "#fee2e2", fg: "#b91c1c" },
  coffee: { icon: "cafe", bg: "#fef3c7", fg: theme.amber },
};

const FALLBACK = { icon: "card" as IconName, bg: theme.chipBg, fg: theme.slate };

export function CategoryIcon({ category }: { category?: string }) {
  const spec = (category && CATEGORY_ICONS[category.toLowerCase()]) || FALLBACK;
  return (
    <View style={[styles.iconChip, { backgroundColor: spec.bg }]}>
      <Ionicons name={spec.icon} size={18} color={spec.fg} />
    </View>
  );
}

export function TxnRow({ txn }: { txn: DashboardTxn }) {
  return (
    <View style={styles.txnRow}>
      <CategoryIcon {...(txn.category !== undefined ? { category: txn.category } : {})} />
      <View style={styles.txnBody}>
        <Text style={styles.txnMerchant} numberOfLines={1}>
          {txn.merchant}
          {txn.pending ? "  (pending)" : ""}
        </Text>
        {txn.category ? <Text style={styles.txnCategory}>{txn.category}</Text> : null}
      </View>
      <Text style={[styles.txnAmount, { color: txn.isInflow ? theme.inflow : theme.outflow }]}>
        {txn.amountFormatted}
      </Text>
    </View>
  );
}

export function StatTile(props: { label: string; value: string; up: boolean }) {
  return (
    <View style={styles.statTile}>
      <View style={styles.statHeader}>
        <Text style={styles.statLabel}>{props.label}</Text>
        <View
          style={[
            styles.statArrow,
            { backgroundColor: props.up ? "#dcfce7" : "#fee2e2" },
          ]}
        >
          <Ionicons
            name={props.up ? "arrow-up" : "arrow-down"}
            size={12}
            color={props.up ? theme.primaryDark : theme.outflow}
          />
        </View>
      </View>
      <Text style={styles.statValue}>{props.value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  iconChip: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  txnRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10 },
  txnBody: { flex: 1, marginHorizontal: 12 },
  txnMerchant: { fontSize: 15, fontWeight: "600", color: theme.ink },
  txnCategory: { fontSize: 12, color: theme.slate, marginTop: 2 },
  txnAmount: { fontSize: 15, fontWeight: "700" },
  statTile: {
    flex: 1,
    backgroundColor: theme.card,
    borderRadius: 14,
    padding: 14,
  },
  statHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  statLabel: { fontSize: 12, color: theme.slate },
  statArrow: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  statValue: { fontSize: 18, fontWeight: "800", color: theme.ink, marginTop: 6 },
});
