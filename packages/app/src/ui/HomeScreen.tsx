/**
 * Dashboard per docs/uiDesign/image2.png screen 1: greeting, green balance
 * card, Quick Overview stat tiles, Recent Transactions. One doctrinal
 * addition the mockup lacked: the balance card carries the data-age label —
 * every displayed number carries a knowable data age (SystemInvariants.md).
 */
import { ScrollView, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { DashboardViewModel } from "../data/dashboardModel";
import { StatTile, TxnRow } from "./bits";
import { theme } from "./theme";

export function HomeScreen(props: {
  vm: DashboardViewModel;
  offline: boolean;
  /** Queued writes waiting for the network (outbox). */
  pendingCount: number;
  refreshing: boolean;
  onRefresh: () => void;
  onSeeAll: () => void;
  onAddFirst: () => void;
  onAsk: () => void;
}) {
  const { vm } = props;
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={props.refreshing} onRefresh={props.onRefresh} />}
    >
      <Text style={styles.greeting}>Good morning 👋</Text>
      <Text style={styles.subtitle}>Here's your financial overview</Text>
      {props.offline && <Text style={styles.offline}>Offline — showing saved data</Text>}
      {props.pendingCount > 0 && (
        <Text style={styles.offline}>
          {props.pendingCount} change{props.pendingCount === 1 ? "" : "s"} will sync when online
        </Text>
      )}

      <View style={styles.balanceCard}>
        <Text style={styles.balanceLabel}>Available Cash</Text>
        <Text style={styles.balanceValue}>{vm.availableCashFormatted}</Text>
        <Text style={styles.balanceAge}>{vm.dataAgeLabel}</Text>
      </View>

      {vm.hasAccounts ? (
        <>
          <Pressable style={styles.askCard} onPress={props.onAsk}>
            <View style={styles.askIcon}>
              <Ionicons name="sparkles" size={18} color={theme.onPrimary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.askTitle}>Can I buy this?</Text>
              <Text style={styles.askSub}>Check a purchase against your real numbers</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={theme.primary} />
          </Pressable>

          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Quick Overview</Text>
            <Text style={styles.sectionMeta}>This Month</Text>
          </View>
          <View style={styles.tiles}>
            <StatTile label="Income" value={vm.incomeThisMonthFormatted} up />
            <StatTile label="Expenses" value={vm.expensesThisMonthFormatted} up={false} />
          </View>

          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Recent Transactions</Text>
            <Pressable onPress={props.onSeeAll}>
              <Text style={styles.seeAll}>See All</Text>
            </Pressable>
          </View>
          <View style={styles.card}>
            {vm.recentTransactions.map((t) => (
              <TxnRow key={t.txnId} txn={t} />
            ))}
          </View>
        </>
      ) : (
        <Pressable style={styles.cta} onPress={props.onAddFirst}>
          <Text style={styles.ctaText}>Add your first account</Text>
        </Pressable>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  content: { paddingTop: 72, paddingHorizontal: 20, paddingBottom: 24 },
  greeting: { fontSize: 22, fontWeight: "800", color: theme.ink },
  subtitle: { fontSize: 13, color: theme.slate, marginTop: 2, marginBottom: 14 },
  offline: { color: theme.amber, marginBottom: 8, fontSize: 12 },
  balanceCard: {
    backgroundColor: theme.primaryDeep,
    borderRadius: 18,
    padding: 20,
    marginBottom: 18,
  },
  balanceLabel: { color: theme.onPrimaryFaint, fontSize: 13 },
  balanceValue: { color: theme.onPrimary, fontSize: 36, fontWeight: "800", marginVertical: 4 },
  balanceAge: { color: theme.onPrimaryFaint, fontSize: 12 },
  askCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: theme.card,
    borderRadius: 16,
    padding: 14,
    marginBottom: 18,
    borderWidth: 1,
    borderColor: theme.divider,
  },
  askIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  askTitle: { fontSize: 15, fontWeight: "700", color: theme.ink },
  askSub: { fontSize: 12, color: theme.slate, marginTop: 2 },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 6,
    marginBottom: 10,
  },
  sectionTitle: { fontSize: 16, fontWeight: "700", color: theme.ink },
  sectionMeta: { fontSize: 12, color: theme.slate },
  seeAll: { fontSize: 13, color: theme.primary, fontWeight: "600" },
  tiles: { flexDirection: "row", gap: 12, marginBottom: 12 },
  card: { backgroundColor: theme.card, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 4 },
  cta: { backgroundColor: theme.primary, borderRadius: 14, padding: 16, alignItems: "center" },
  ctaText: { color: theme.onPrimary, fontWeight: "700" },
});
