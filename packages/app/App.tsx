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
import { foldAccounts } from "@xerebro/engines";
import { resolveApiUrl } from "./src/data/apiUrl";
import { buildDashboardViewModel, type DashboardViewModel } from "./src/data/dashboardModel";
import { buildPlanViewModel, type PlanViewModel } from "./src/data/planModel";
import {
  enhanceExplanation,
  runPurchaseCheck,
  submitFeedback,
  type DecisionFlowDeps,
  type EnhancedExplanation,
  type PurchaseCheckResult,
} from "./src/data/decisionFlow";
import type { DeviceEventLog } from "./src/data/deviceLog";
import { authedHttpTransport } from "./src/data/httpTransport";
import { openDeviceLog } from "./src/data/openDeviceLog";
import { openTokenStore } from "./src/data/openTokenStore";
import { flushOutbox, pullOnce, sendOrQueue, type SyncTransport } from "./src/data/syncClient";
import { type Outbox } from "./src/data/outbox";
import { createProjectionCache } from "./src/data/projectionCache";
import { openOutbox } from "./src/data/openOutbox";
import {
  accountUpserted,
  billUpserted,
  bucketUpserted,
  manualTransaction,
  type EventFactoryDeps,
  type OutgoingEvent,
} from "./src/data/userEvents";
import { AddEntryScreen, type NewAccount, type NewTransaction } from "./src/ui/AddEntryScreen";
import { linkBankAccount } from "./src/data/plaidLink";
import { webAuthOpener } from "./src/data/openWebAuth";
import { AskScreen } from "./src/ui/AskScreen";
import { ChatScreen } from "./src/ui/ChatScreen";
import { BudgetScreen, type NewBill, type NewBucket } from "./src/ui/BudgetScreen";
import { HomeScreen } from "./src/ui/HomeScreen";
import { PlaceholderScreen } from "./src/ui/PlaceholderScreen";
import { TabBar, type Tab } from "./src/ui/TabBar";
import { theme } from "./src/ui/theme";
import { TransactionsScreen } from "./src/ui/TransactionsScreen";

const API_URL = resolveApiUrl();
/** Where Plaid's hosted Link returns after the user finishes. */
const REDIRECT_URL = "xerebro://plaid";

const factoryDeps: EventFactoryDeps = {
  newId: () => `${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
  nowIso: () => new Date().toISOString(),
  deviceId: "device-a",
};

export default function App() {
  const [log, setLog] = useState<DeviceEventLog | null>(null);
  const [outbox, setOutbox] = useState<Outbox | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  // Auth-aware transport: registers this device on first contact, refreshes
  // rotated tokens transparently, stores the pair in the platform keychain.
  const [transport, setTransport] = useState<SyncTransport | null>(null);
  const [userId, setUserId] = useState("unregistered");
  const [vm, setVm] = useState<DashboardViewModel | null>(null);
  const [planVm, setPlanVm] = useState<PlanViewModel | null>(null);
  const [accounts, setAccounts] = useState<{ accountId: string; name: string }[]>([]);
  const [offline, setOffline] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<Tab>("home");
  const [asking, setAsking] = useState(false);
  const [entering, setEntering] = useState(false);
  const [chatting, setChatting] = useState(false);
  const [amountText, setAmountText] = useState("");
  const [descriptionText, setDescriptionText] = useState("");
  const [checking, setChecking] = useState(false);
  const [answer, setAnswer] = useState<PurchaseCheckResult | null>(null);
  const [enhanced, setEnhanced] = useState<EnhancedExplanation | null>(null);
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [linking, setLinking] = useState(false);
  const [linkNotice, setLinkNotice] = useState("");
  /** Folded state cached across renders; survives for the app's lifetime. */
  const [projections] = useState(() => createProjectionCache());

  const rebuild = useCallback(async (deviceLog: DeviceEventLog, box: Outbox) => {
    // Optimistic view: cached snapshot of committed events + queued outbox
    // events wearing provisional sequences. An offline action shows up
    // instantly, and the cache means a render folds only what's NEW
    // (projectionCache.ts) rather than re-folding all history.
    const snapshot = await projections.withPending(deviceLog, await box.all());
    setPendingCount(await box.size());
    const now = new Date();
    const todayLocal = now.toISOString().slice(0, 10);
    setVm(buildDashboardViewModel({ snapshot, todayLocal, nowIso: now.toISOString() }));
    setPlanVm(buildPlanViewModel({ snapshot, todayLocal }));
    setAccounts(
      snapshot.accounts
        .filter((a) => a.source === "manual" && a.status === "active")
        .map((a) => ({ accountId: a.accountId, name: a.name })),
    );
  }, [projections]);

  /** Every manual write goes through the same offline-safe path (Milestone 7)
   * and repaints optimistically. Returns nothing — the outbox guarantees the
   * events are durable whether or not the network was reachable. */
  const submit = useCallback(
    async (events: readonly OutgoingEvent[]) => {
      if (!log || !outbox || !transport) return;
      const result = await sendOrQueue(transport, log, outbox, events);
      setOffline(result.status === "queued");
      await rebuild(log, outbox);
    },
    [log, outbox, transport, rebuild],
  );

  const sync = useCallback(
    async (t: SyncTransport, deviceLog: DeviceEventLog, box: Outbox) => {
      try {
        await flushOutbox(t, deviceLog, box); // queued writes first
        await pullOnce(t, deviceLog);
        setOffline(false);
      } catch {
        setOffline(true); // local-first: render what we have, labeled
      }
      await rebuild(deviceLog, box);
    },
    [rebuild],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [deviceLog, box, tokenStore] = await Promise.all([
        openDeviceLog(),
        openOutbox(),
        openTokenStore(),
      ]);
      if (cancelled) return;
      const t = authedHttpTransport(API_URL, tokenStore);
      setLog(deviceLog);
      setOutbox(box);
      setTransport(t);
      await rebuild(deviceLog, box); // cache paints first
      await sync(t, deviceLog, box); // network never blocks first paint
      // Identity is known after first contact (registration happens lazily).
      setUserId((await tokenStore.get())?.userId ?? "unregistered");
    })();
    return () => {
      cancelled = true;
    };
  }, [rebuild, sync]);

  const flowDeps = useCallback((): DecisionFlowDeps | null => {
    if (!log || !outbox || !transport) return null;
    return { log, outbox, transport, factory: factoryDeps, userId, projections };
  }, [log, outbox, transport, userId]);

  const onCheck = useCallback(async () => {
    const deps = flowDeps();
    // UI boundary: dollars text → integer cents immediately; the float dies here.
    const amountMinor = Math.round(Number.parseFloat(amountText) * 100);
    if (!deps || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) return;
    setChecking(true);
    setFeedbackSent(false);
    setEnhanced(null);
    let result: PurchaseCheckResult | null = null;
    try {
      const description = descriptionText.trim() || undefined;
      result = await runPurchaseCheck(deps, amountMinor, description);
      setAnswer(result); // beat 1: verdict + template, instantly
      setOffline(result.offline);
    } finally {
      setChecking(false);
    }
    if (log && outbox) await rebuild(log, outbox);
    if (result) {
      // beat 2: richer prose arrives when it arrives; template stands otherwise
      const better = await enhanceExplanation(deps, result.record);
      if (better) setEnhanced(better);
    }
  }, [flowDeps, amountText, descriptionText, log, outbox, rebuild]);

  const onFeedback = useCallback(
    async (response: "accepted" | "ignored") => {
      const deps = flowDeps();
      if (!deps || !answer) return;
      await submitFeedback(deps, answer.record.recommendationId, response);
      setFeedbackSent(true);
    },
    [flowDeps, answer],
  );

  const onAddAccount = useCallback(
    async (a: NewAccount) => {
      const nowIso = factoryDeps.nowIso();
      await submit([
        accountUpserted(factoryDeps, {
          accountId: factoryDeps.newId(),
          type: "checking",
          source: "manual",
          name: a.name,
          currency: "USD",
          balanceCurrentMinor: a.openingBalanceMinor,
          balanceAsOf: nowIso,
          status: "active",
          openingBalanceMinor: a.openingBalanceMinor,
        }),
      ]);
      setEntering(false);
    },
    [submit],
  );

  const onAddTransaction = useCallback(
    async (t: NewTransaction) => {
      await submit([
        manualTransaction(factoryDeps, {
          txnId: factoryDeps.newId(),
          accountId: t.accountId,
          amountMinor: t.amountMinor,
          currency: "USD",
          status: "posted",
          postedDate: t.postedDate,
          merchantRaw: t.merchant,
          ...(t.category ? { category: t.category } : {}),
          categorySource: "user",
        }),
      ]);
      setEntering(false);
    },
    [submit],
  );

  const onAddBucket = useCallback(
    async (b: NewBucket) => {
      await submit([
        bucketUpserted(factoryDeps, {
          bucketId: factoryDeps.newId(),
          name: b.name,
          allocatedMinor: b.allocatedMinor,
          ...(b.targetMinor !== undefined ? { targetMinor: b.targetMinor } : {}),
        }),
      ]);
    },
    [submit],
  );

  const onAddBill = useCallback(
    async (b: NewBill) => {
      await submit([
        billUpserted(factoryDeps, {
          billId: factoryDeps.newId(),
          name: b.name,
          expectedAmountMinor: b.expectedAmountMinor,
          nextDue: b.nextDue,
        }),
      ]);
    },
    [submit],
  );

  /** Bank linking: hosted Plaid Link, then a resync so the new accounts and
   * transactions appear (the ACCESS token stays server-side throughout). */
  const onLinkBank = useCallback(async () => {
    if (!transport || !log || !outbox) return;
    setLinking(true);
    setLinkNotice("");
    try {
      const outcome = await linkBankAccount(transport, webAuthOpener, REDIRECT_URL);
      if (outcome.status === "linked") {
        projections.invalidate(); // fresh aggregator history: refold cleanly
        await sync(transport, log, outbox);
        setEntering(false);
      } else if (outcome.status === "unavailable") {
        setLinkNotice("Bank linking isn't configured on the server yet.");
      } else if (outcome.status === "failed") {
        setLinkNotice(outcome.reason);
      }
    } finally {
      setLinking(false);
    }
  }, [transport, log, outbox, projections, sync]);

  const onRefresh = useCallback(async () => {
    if (!log || !outbox || !transport) return;
    setRefreshing(true);
    await sync(transport, log, outbox);
    setRefreshing(false);
  }, [log, outbox, transport, sync]);

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
        {chatting && transport ? (
          <ChatScreen transport={transport} onBack={() => setChatting(false)} />
        ) : entering ? (
          <AddEntryScreen
            accounts={accounts}
            todayLocal={new Date().toISOString().slice(0, 10)}
            onSubmitAccount={onAddAccount}
            onSubmitTransaction={onAddTransaction}
            onBack={() => setEntering(false)}
            onLinkBank={onLinkBank}
            linking={linking}
            {...(linkNotice ? { linkNotice } : {})}
          />
        ) : asking ? (
          <AskScreen
            amountText={amountText}
            onAmountText={setAmountText}
            descriptionText={descriptionText}
            onDescriptionText={setDescriptionText}
            checking={checking}
            onCheck={onCheck}
            onBack={() => setAsking(false)}
            answer={answer}
            enhanced={enhanced}
            feedbackSent={feedbackSent}
            onFeedback={onFeedback}
          />
        ) : tab === "home" ? (
          <HomeScreen
            vm={vm}
            offline={offline}
            pendingCount={pendingCount}
            refreshing={refreshing}
            onRefresh={onRefresh}
            onSeeAll={() => setTab("transactions")}
            onAddFirst={() => setEntering(true)}
            onAsk={() => setAsking(true)}
          />
        ) : tab === "transactions" ? (
          <TransactionsScreen vm={vm} onAdd={() => setEntering(true)} />
        ) : tab === "budget" && planVm ? (
          <BudgetScreen vm={planVm} onAddBucket={onAddBucket} onAddBill={onAddBill} />
        ) : (
          <PlaceholderScreen
            title="Reports"
            note="Spending reports arrive after the budget milestone. Nothing here will ever be estimated silently."
          />
        )}
      </View>
      {!asking && !entering && !chatting && (
        <TabBar
          active={tab}
          onTab={(t) => {
            setTab(t);
            setAsking(false);
          }}
          onAsk={() => setChatting(true)}
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
