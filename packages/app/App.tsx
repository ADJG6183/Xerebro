/**
 * Home screen (docs/V1Scope.md dashboard): renders ONLY from the local
 * device log — the local-first invariant, visible. Sync happens in the
 * background; if the server is unreachable the screen still renders from
 * whatever is stored, labeled with its data age.
 */
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { buildDashboardViewModel, type DashboardViewModel } from "./src/data/dashboardModel";
import type { DeviceEventLog } from "./src/data/deviceLog";
import { httpTransport } from "./src/data/httpTransport";
import { openSqliteDeviceLog } from "./src/data/sqliteLog";
import { pullOnce, pushUserEvents, type SyncTransport } from "./src/data/syncClient";
import { accountUpserted, manualTransaction, type EventFactoryDeps } from "./src/data/userEvents";

const USER_ID = "user-1"; // real auth arrives with the security milestone
const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3000";

const factoryDeps: EventFactoryDeps = {
  newId: () => `${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
  nowIso: () => new Date().toISOString(),
  deviceId: "device-a",
};

export default function App() {
  const [log, setLog] = useState<DeviceEventLog | null>(null);
  const [transport] = useState<SyncTransport>(() => httpTransport(API_URL));
  const [vm, setVm] = useState<DashboardViewModel | null>(null);
  const [offline, setOffline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const rebuild = useCallback(async (deviceLog: DeviceEventLog) => {
    const events = await deviceLog.all();
    const now = new Date();
    setVm(
      buildDashboardViewModel({
        events,
        todayLocal: now.toISOString().slice(0, 10),
        nowIso: now.toISOString(),
      }),
    );
  }, []);

  const sync = useCallback(
    async (deviceLog: DeviceEventLog) => {
      try {
        await pullOnce(transport, deviceLog, USER_ID);
        setOffline(false);
      } catch {
        setOffline(true); // local-first: render what we have, labeled
      }
      await rebuild(deviceLog);
    },
    [transport, rebuild],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const deviceLog = await openSqliteDeviceLog();
      if (cancelled) return;
      setLog(deviceLog);
      await rebuild(deviceLog); // paint from cache FIRST
      await sync(deviceLog); // network never blocks first paint
    })();
    return () => {
      cancelled = true;
    };
  }, [rebuild, sync]);

  const addDemoAccount = useCallback(async () => {
    if (!log) return;
    const nowIso = factoryDeps.nowIso();
    const events = [
      accountUpserted(factoryDeps, {
        accountId: "manual-checking",
        type: "checking",
        source: "manual",
        name: "My Checking",
        currency: "USD",
        balanceCurrentMinor: 0,
        balanceAsOf: nowIso,
        status: "active",
        openingBalanceMinor: 500_000,
      }),
      manualTransaction(factoryDeps, {
        txnId: "demo-groceries",
        accountId: "manual-checking",
        amountMinor: -6_842,
        currency: "USD",
        status: "posted",
        postedDate: nowIso.slice(0, 10),
        merchantRaw: "Grocery Store",
        category: "Groceries",
        categorySource: "user",
      }),
      manualTransaction(factoryDeps, {
        txnId: "demo-salary",
        accountId: "manual-checking",
        amountMinor: 240_000,
        currency: "USD",
        status: "posted",
        postedDate: nowIso.slice(0, 10),
        merchantRaw: "Salary",
        category: "Income",
        categorySource: "user",
      }),
    ];
    try {
      await pushUserEvents(transport, log, USER_ID, events);
      setOffline(false);
    } catch {
      setOffline(true);
    }
    await rebuild(log);
  }, [log, transport, rebuild]);

  const onRefresh = useCallback(async () => {
    if (!log) return;
    setRefreshing(true);
    await sync(log);
    setRefreshing(false);
  }, [log, sync]);

  if (!vm) {
    return (
      <View style={styles.container}>
        <Text style={styles.muted}>First sync…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar style="auto" />
      <Text style={styles.greeting}>Good morning 👋</Text>
      {offline && <Text style={styles.offline}>Offline — showing saved data</Text>}

      <View style={styles.balanceCard}>
        <Text style={styles.balanceLabel}>Available Cash</Text>
        <Text style={styles.balanceValue}>{vm.availableCashFormatted}</Text>
        <Text style={styles.balanceAge}>{vm.dataAgeLabel}</Text>
      </View>

      {vm.hasAccounts ? (
        <FlatList
          style={styles.list}
          data={vm.recentTransactions}
          keyExtractor={(t) => t.txnId}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          ListHeaderComponent={<Text style={styles.sectionTitle}>Recent Transactions</Text>}
          renderItem={({ item }) => (
            <View style={styles.txnRow}>
              <View style={styles.txnLeft}>
                <Text style={styles.txnMerchant}>
                  {item.merchant}
                  {item.pending ? "  (pending)" : ""}
                </Text>
                {item.category ? <Text style={styles.muted}>{item.category}</Text> : null}
              </View>
              <Text style={[styles.txnAmount, item.isInflow ? styles.inflow : styles.outflow]}>
                {item.amountFormatted}
              </Text>
            </View>
          )}
        />
      ) : (
        <Pressable style={styles.cta} onPress={addDemoAccount}>
          <Text style={styles.ctaText}>Add demo checking account</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f3faf6", paddingTop: 72, paddingHorizontal: 20 },
  greeting: { fontSize: 22, fontWeight: "700", color: "#10241a", marginBottom: 12 },
  offline: { color: "#8a6d1a", marginBottom: 8 },
  balanceCard: { backgroundColor: "#17b978", borderRadius: 16, padding: 20, marginBottom: 20 },
  balanceLabel: { color: "#e6fff4", fontSize: 14 },
  balanceValue: { color: "#ffffff", fontSize: 34, fontWeight: "800", marginVertical: 4 },
  balanceAge: { color: "#d2f7e6", fontSize: 12 },
  sectionTitle: { fontSize: 16, fontWeight: "700", color: "#10241a", marginBottom: 8 },
  list: { flex: 1 },
  txnRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#d7e8de",
  },
  txnLeft: { flexShrink: 1, paddingRight: 12 },
  txnMerchant: { fontSize: 15, fontWeight: "600", color: "#10241a" },
  txnAmount: { fontSize: 15, fontWeight: "700" },
  inflow: { color: "#0c8a56" },
  outflow: { color: "#b3261e" },
  muted: { color: "#5f7268", fontSize: 12 },
  cta: { backgroundColor: "#10241a", borderRadius: 12, padding: 16, alignItems: "center" },
  ctaText: { color: "#ffffff", fontWeight: "700" },
});
