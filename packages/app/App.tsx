/**
 * Shell: wires data (device log, sync, decision flow) to the mockup-faithful
 * screens (docs/uiDesign/image2.png). No navigation library yet — a tab enum
 * covers four tabs + one modal-style flow; a nav dependency earns its place
 * when deep-linking or real stacks arrive. The UI stays a dumb painter:
 * every number and sentence comes from tested modules.
 */
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { resolveApiUrl } from "./src/data/apiUrl";
import { buildDashboardViewModel, type DashboardViewModel } from "./src/data/dashboardModel";
import {
  runPurchaseCheck,
  submitFeedback,
  type DecisionFlowDeps,
  type PurchaseCheckResult,
} from "./src/data/decisionFlow";
import type { DeviceEventLog } from "./src/data/deviceLog";
import { httpTransport } from "./src/data/httpTransport";
import { openDeviceLog } from "./src/data/openDeviceLog";
import { pullOnce, pushUserEvents } from "./src/data/syncClient";
import { accountUpserted, manualTransaction, type EventFactoryDeps } from "./src/data/userEvents";
import { AskScreen } from "./src/ui/AskScreen";
import { HomeScreen } from "./src/ui/HomeScreen";
import { PlaceholderScreen } from "./src/ui/PlaceholderScreen";
import { TabBar, type Tab } from "./src/ui/TabBar";
import { theme } from "./src/ui/theme";
import { TransactionsScreen } from "./src/ui/TransactionsScreen";

const USER_ID = "user-1"; // real auth arrives with the security milestone
const API_URL = resolveApiUrl();

const factoryDeps: EventFactoryDeps = {
  newId: () => `${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
  nowIso: () => new Date().toISOString(),
  deviceId: "device-a",
};

export default function App() {
  const [log, setLog] = useState<DeviceEventLog | null>(null);
  const [transport] = useState(() => httpTransport(API_URL));
  const [vm, setVm] = useState<DashboardViewModel | null>(null);
  const [offline, setOffline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<Tab>("home");
  const [asking, setAsking] = useState(false);
  const [amountText, setAmountText] = useState("");
  const [checking, setChecking] = useState(false);
  const [answer, setAnswer] = useState<PurchaseCheckResult | null>(null);
  const [feedbackSent, setFeedbackSent] = useState(false);

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
      const deviceLog = await openDeviceLog();
      if (cancelled) return;
      setLog(deviceLog);
      await rebuild(deviceLog); // cache paints first
      await sync(deviceLog); // network never blocks first paint
    })();
    return () => {
      cancelled = true;
    };
  }, [rebuild, sync]);

  const flowDeps = useCallback((): DecisionFlowDeps | null => {
    if (!log) return null;
    return { log, transport, factory: factoryDeps, userId: USER_ID };
  }, [log, transport]);

  const onCheck = useCallback(async () => {
    const deps = flowDeps();
    // UI boundary: dollars text → integer cents immediately; the float dies here.
    const amountMinor = Math.round(Number.parseFloat(amountText) * 100);
    if (!deps || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) return;
    setChecking(true);
    setFeedbackSent(false);
    try {
      const result = await runPurchaseCheck(deps, amountMinor);
      setAnswer(result);
      setOffline(result.offline);
    } finally {
      setChecking(false);
    }
    if (log) await rebuild(log);
  }, [flowDeps, amountText, log, rebuild]);

  const onFeedback = useCallback(
    async (response: "accepted" | "ignored") => {
      const deps = flowDeps();
      if (!deps || !answer) return;
      await submitFeedback(deps, answer.record.recommendationId, response);
      setFeedbackSent(true);
    },
    [flowDeps, answer],
  );

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
      <View style={styles.loading}>
        <Text style={styles.loadingText}>First sync…</Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <StatusBar style="auto" />
      <View style={styles.body}>
        {asking ? (
          <AskScreen
            amountText={amountText}
            onAmountText={setAmountText}
            checking={checking}
            onCheck={onCheck}
            onBack={() => setAsking(false)}
            answer={answer}
            feedbackSent={feedbackSent}
            onFeedback={onFeedback}
          />
        ) : tab === "home" ? (
          <HomeScreen
            vm={vm}
            offline={offline}
            refreshing={refreshing}
            onRefresh={onRefresh}
            onSeeAll={() => setTab("transactions")}
            onAddDemo={addDemoAccount}
          />
        ) : tab === "transactions" ? (
          <TransactionsScreen vm={vm} />
        ) : tab === "budget" ? (
          <PlaceholderScreen
            title="Budget"
            note="Buckets and paycheck planning arrive in a later milestone — designed in docs/V1Scope.md, not yet built."
          />
        ) : (
          <PlaceholderScreen
            title="Reports"
            note="Spending reports arrive after the budget milestone. Nothing here will ever be estimated silently."
          />
        )}
      </View>
      {!asking && (
        <TabBar
          active={tab}
          onTab={(t) => {
            setTab(t);
            setAsking(false);
          }}
          onAsk={() => setAsking(true)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  body: { flex: 1 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.bg },
  loadingText: { color: theme.slate },
});
