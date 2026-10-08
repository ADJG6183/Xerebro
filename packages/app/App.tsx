/**
 * Shell: wires data (device log, sync, decision flow) to the mockup-faithful
 * screens (docs/uiDesign/image2.png). No navigation library yet — a tab enum
 * covers four tabs + one modal-style flow; a nav dependency earns its place
 * when deep-linking or real stacks arrive. The UI stays a dumb painter:
 * every number and sentence comes from tested modules.
 */
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { foldAccounts, type ProjectionSnapshot } from "@xerebro/engines";
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
import {
  flushOutbox,
  pullOnce,
  sendOrQueue,
  type ConnectedItem,
  type SyncTransport,
} from "./src/data/syncClient";
import { type Outbox } from "./src/data/outbox";
import { createProjectionCache } from "./src/data/projectionCache";
import { openOutbox } from "./src/data/openOutbox";
import {
  accountUpserted,
  billUpserted,
  budgetPlanUpserted,
  bucketUpserted,
  manualTransaction,
  transactionAnnotated,
  type EventFactoryDeps,
  type OutgoingEvent,
} from "./src/data/userEvents";
import { buildTransactionDetail } from "./src/data/transactionDetailModel";
import { AddEntryScreen, type NewAccount, type NewTransaction } from "./src/ui/AddEntryScreen";
import { linkBankAccount } from "./src/data/plaidLink";
import { formatLocalDate } from "./src/data/localDate";
import { buildAccountViewModel, type AccountViewModel } from "./src/data/accountModel";
import { webAuthOpener } from "./src/data/openWebAuth";
import { AskScreen } from "./src/ui/AskScreen";
import { ChatScreen } from "./src/ui/ChatScreen";
import { AccountsScreen } from "./src/ui/AccountsScreen";
import { BudgetScreen, type NewBill, type NewBucket, type NewBudget } from "./src/ui/BudgetScreen";
import { HomeScreen } from "./src/ui/HomeScreen";
import { TabBar, type Tab } from "./src/ui/TabBar";
import { theme } from "./src/ui/theme";
import { SpendingScreen } from "./src/ui/SpendingScreen";
import { TransactionDetailScreen } from "./src/ui/TransactionDetailScreen";

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
  const [accountVm, setAccountVm] = useState<AccountViewModel>({ groups: [], accountCount: 0 });
  const connectionCache = useRef<ConnectedItem[]>([]);
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
  const [snapshot, setSnapshot] = useState<ProjectionSnapshot | null>(null);
  const [selectedTxnId, setSelectedTxnId] = useState<string | null>(null);
  const [savingAnnotation, setSavingAnnotation] = useState(false);
  /** Set when Budget's "open scoped spending" sends the user to Spending
   * pre-filtered by category; cleared on any ORDINARY tab-bar tap so a
   * later, unrelated visit to Spending doesn't inherit a stale filter. */
  const [spendingInitialCategory, setSpendingInitialCategory] = useState<string | undefined>(
    undefined,
  );
  /** Identifies which "Check" press a result/enhancement belongs to. The
   * amount input re-enables as soon as the verdict renders (beat 1) while
   * the AI explanation (beat 2) can still be in flight — without this, a
   * second, faster check's answer can be overwritten by the first check's
   * late-arriving (and now-irrelevant) explanation. */
  const checkRequestId = useRef(0);
  /** Folded state cached across renders; survives for the app's lifetime. */
  const [projections] = useState(() => createProjectionCache());

  const rebuild = useCallback(async (
    deviceLog: DeviceEventLog,
    box: Outbox,
    connectionTransport?: SyncTransport,
  ) => {
    // Optimistic view: cached snapshot of committed events + queued outbox
    // events wearing provisional sequences. An offline action shows up
    // instantly, and the cache means a render folds only what's NEW
    // (projectionCache.ts) rather than re-folding all history.
    const snap = await projections.withPending(deviceLog, await box.all());
    setSnapshot(snap);
    setPendingCount(await box.size());
    const now = new Date();
    const todayLocal = formatLocalDate(now);
    setVm(buildDashboardViewModel({ snapshot: snap, todayLocal, nowIso: now.toISOString() }));
    setPlanVm(buildPlanViewModel({ snapshot: snap, todayLocal }));
    if (connectionTransport?.listItems) {
      try {
        connectionCache.current = (await connectionTransport.listItems()).items;
      } catch {
        // Keep the last known lifecycle labels while offline.
      }
    }
    setAccountVm(
      buildAccountViewModel({
        snapshot: snap,
        nowIso: now.toISOString(),
        connections: connectionCache.current,
      }),
    );
    setAccounts(
      snap.accounts
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
      await rebuild(log, outbox, transport);
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
      await rebuild(deviceLog, box, t);
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
    return {
      log,
      outbox,
      transport,
      factory: factoryDeps,
      userId,
      projections,
      todayLocal: () => formatLocalDate(new Date()),
    };
  }, [log, outbox, transport, userId]);

  const onCheck = useCallback(async () => {
    const deps = flowDeps();
    // UI boundary: dollars text → integer cents immediately; the float dies here.
    const amountMinor = Math.round(Number.parseFloat(amountText) * 100);
    if (!deps || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) return;
    const requestId = ++checkRequestId.current;
    setChecking(true);
    setFeedbackSent(false);
    setEnhanced(null);
    let result: PurchaseCheckResult | null = null;
    try {
      const description = descriptionText.trim() || undefined;
      result = await runPurchaseCheck(deps, amountMinor, description);
      // The amount/description inputs re-enable the instant this resolves
      // (below), so a newer check can already be under way by the time we
      // get here if this one was slow — never let a slow check's result
      // land on top of a newer one.
      if (requestId === checkRequestId.current) {
        setAnswer(result); // beat 1: verdict + template, instantly
        setOffline(result.offline);
      }
    } finally {
      if (requestId === checkRequestId.current) setChecking(false);
    }
    if (log && outbox) await rebuild(log, outbox, transport ?? undefined);
    if (result && requestId === checkRequestId.current) {
      // beat 2: richer prose arrives when it arrives; template stands
      // otherwise. Re-check after awaiting — a newer check can have
      // started while this was in flight, and that explanation belongs to
      // the amount THIS request checked, not whatever is on screen now.
      const better = await enhanceExplanation(deps, result.record);
      if (better && requestId === checkRequestId.current) setEnhanced(better);
    }
  }, [flowDeps, amountText, descriptionText, log, outbox, transport, rebuild]);

  /** Editing the amount/description after an answer is already showing
   * means that answer no longer describes what's in the box — clear it
   * rather than leave a verdict on screen for a purchase the user has
   * since changed their mind about (bumps the request id too, so a
   * still-in-flight check for the OLD amount can't land afterward). */
  const invalidateAnswer = useCallback(() => {
    if (answer || enhanced) {
      checkRequestId.current += 1;
      setAnswer(null);
      setEnhanced(null);
      setFeedbackSent(false);
    }
  }, [answer, enhanced]);

  const onAmountText = useCallback(
    (t: string) => {
      setAmountText(t);
      invalidateAnswer();
    },
    [invalidateAnswer],
  );

  const onDescriptionText = useCallback(
    (t: string) => {
      setDescriptionText(t);
      invalidateAnswer();
    },
    [invalidateAnswer],
  );

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

  const onAddBudget = useCallback(
    async (b: NewBudget) => {
      await submit([
        budgetPlanUpserted(factoryDeps, {
          categoryId: b.categoryId,
          month: planVm?.budgetMonth ?? formatLocalDate(new Date()).slice(0, 7),
          limitMinor: b.limitMinor,
          enabled: true,
        }),
      ]);
    },
    [submit, planVm],
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

  const onDisconnect = useCallback(
    async (itemId: string) => {
      if (!transport?.disconnectItem || !log || !outbox) return;
      try {
        await transport.disconnectItem(itemId);
        projections.invalidate();
        await sync(transport, log, outbox);
      } catch {
        setOffline(true);
      }
    },
    [transport, log, outbox, projections, sync],
  );

  const onReviewHistory = useCallback(async (command: import("@xerebro/engines").ContinuityCommand) => {
    if (!transport?.reviewAccountHistory || !log || !outbox) throw new Error("Connect to the server to save this review.");
    try {
      await transport.reviewAccountHistory(command);
    } finally {
      projections.invalidate();
      await sync(transport, log, outbox);
    }
  }, [transport, log, outbox, projections, sync]);

  const onOpenCategory = useCallback((categoryId: string) => {
    setSpendingInitialCategory(categoryId);
    setTab("spending");
  }, []);

  const onSaveAnnotation = useCallback(
    async (edit: { categoryOverride?: string; note?: string }) => {
      if (!selectedTxnId) return;
      setSavingAnnotation(true);
      try {
        await submit([transactionAnnotated(factoryDeps, { txnId: selectedTxnId, ...edit })]);
      } finally {
        setSavingAnnotation(false);
        setSelectedTxnId(null);
      }
    },
    [selectedTxnId, submit],
  );

  if (!vm) {
    return (
      <View style={styles.loading}>
        <Text style={styles.loadingText}>First sync…</Text>
      </View>
    );
  }

  const txnDetail = selectedTxnId && snapshot ? buildTransactionDetail(snapshot, selectedTxnId) : null;

  return (
    <View style={styles.root}>
      <StatusBar style="auto" />
      <View style={styles.body}>
        {chatting && transport ? (
          <ChatScreen
            transport={transport}
            onBack={() => setChatting(false)}
            pendingCount={pendingCount}
          />
        ) : txnDetail ? (
          <TransactionDetailScreen
            detail={txnDetail}
            onBack={() => setSelectedTxnId(null)}
            onSave={onSaveAnnotation}
            saving={savingAnnotation}
          />
        ) : entering ? (
          <AddEntryScreen
            accounts={accounts}
            todayLocal={formatLocalDate(new Date())}
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
            onAmountText={onAmountText}
            descriptionText={descriptionText}
            onDescriptionText={onDescriptionText}
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
            onSeeAll={() => setTab("spending")}
            onAddFirst={() => setEntering(true)}
            onAsk={() => setAsking(true)}
          />
        ) : tab === "spending" && snapshot ? (
          <SpendingScreen
            snapshot={snapshot}
            todayLocal={formatLocalDate(new Date())}
            onAdd={() => setEntering(true)}
            onOpenTxn={setSelectedTxnId}
            {...(spendingInitialCategory ? { initialCategory: spendingInitialCategory } : {})}
          />
        ) : tab === "budget" && planVm ? (
          <BudgetScreen
            vm={planVm}
            onAddBucket={onAddBucket}
            onAddBill={onAddBill}
            onAddBudget={onAddBudget}
            onOpenCategory={onOpenCategory}
          />
        ) : (
          <AccountsScreen
            vm={accountVm}
            onAdd={() => setEntering(true)}
            onDisconnect={onDisconnect}
            onReviewHistory={onReviewHistory}
          />
        )}
      </View>
      {!asking && !entering && !chatting && (
        <TabBar
          active={tab}
          onTab={(t) => {
            setTab(t);
            setAsking(false);
            // An ordinary tab tap always starts fresh — a category filter
            // only carries over when Budget's "open scoped spending"
            // explicitly set it (onOpenCategory, which calls setTab itself
            // and never goes through this handler).
            setSpendingInitialCategory(undefined);
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
