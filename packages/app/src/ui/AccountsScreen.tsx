import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import * as Crypto from "expo-crypto";
import type { ContinuityCommand } from "@xerebro/engines";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { AccountViewModel, AccountHistoryViewModel, OverlapViewModel } from "../data/accountModel";
import { theme } from "./theme";

export function AccountsScreen(props: {
  vm: AccountViewModel;
  onAdd: () => void;
  onDisconnect?: (itemId: string) => void;
  onReviewHistory?: (command: ContinuityCommand) => Promise<void>;
}) {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Accounts</Text>
          <Text style={styles.subtitle}>
            {props.vm.accountCount} account{props.vm.accountCount === 1 ? "" : "s"} saved locally
          </Text>
        </View>
        <Pressable style={styles.addButton} onPress={props.onAdd} hitSlop={8}>
          <Ionicons name="add" size={22} color={theme.onPrimary} />
        </Pressable>
      </View>

      {props.vm.groups.map((group) => (
        <View key={group.connectionId} style={styles.group}>
          <View style={styles.groupHeader}>
            <Ionicons
              name={group.source === "plaid" ? "business-outline" : "create-outline"}
              size={17}
              color={theme.primary}
            />
            <Text style={styles.groupTitle}>{group.title}</Text>
            {group.connectionStatusLabel && (
              <Text style={styles.connectionStatus}>{group.connectionStatusLabel}</Text>
            )}
          </View>
          {group.message && <Text style={styles.message}>{group.message}</Text>}
          {group.accounts.map((account) => (
            <View key={account.accountId} style={styles.card}>
              <View style={styles.row}>
                <View style={styles.accountText}>
                  <Text style={styles.accountName}>{account.name}</Text>
                  <Text style={styles.meta}>
                    {account.typeLabel}
                    {account.maskLabel ? ` · ${account.maskLabel}` : ""}
                    {` · ${account.statusLabel}`}
                  </Text>
                </View>
                <Text style={styles.balance}>{account.balanceFormatted}</Text>
              </View>
              {account.spendingCapacityFormatted !== undefined && (
                <Text style={styles.capacity}>
                  Available to spend: {account.spendingCapacityFormatted}
                </Text>
              )}
              <Text style={styles.basis}>{account.balanceBasisLabel}</Text>
              <Text style={styles.meta}>
                {account.ageLabel} · {account.transactionCount} transaction
                {account.transactionCount === 1 ? "" : "s"}
              </Text>
              {account.history && <HistoryReview history={account.history} onSave={props.onReviewHistory} />}
            </View>
          ))}
          {group.source === "plaid" && group.canDisconnect && props.onDisconnect && (
            <Pressable
              style={styles.disconnectButton}
              onPress={() =>
                Alert.alert(
                  "Disconnect this bank?",
                  "Future bank updates will stop. Imported transactions stay in your history, and this balance will no longer count as spendable cash.",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Disconnect",
                      style: "destructive",
                      onPress: () => props.onDisconnect?.(group.connectionId),
                    },
                  ],
                )
              }
            >
              <Text style={styles.disconnectText}>Disconnect bank</Text>
            </Pressable>
          )}
        </View>
      ))}

      {props.vm.groups.length === 0 && (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No accounts yet</Text>
          <Text style={styles.meta}>Add one manually or securely connect your bank.</Text>
          <Pressable style={styles.emptyButton} onPress={props.onAdd}>
            <Text style={styles.emptyButtonText}>Add an account</Text>
          </Pressable>
        </View>
      )}
    </ScrollView>
  );
}

function HistoryReview({ history, onSave }: {
  history: AccountHistoryViewModel;
  onSave?: ((command: ContinuityCommand) => Promise<void>) | undefined;
}) {
  const [confirmation, setConfirmation] = useState<{ command: ContinuityCommand; label: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [visible, setVisible] = useState(10);
  const c = history.continuity;
  const proposeAccount = (decision: "same" | "different" | "reopen", label: string, predecessorId?: string) => {
    setConfirmation({ label, command: { kind: "account", commandId: Crypto.randomUUID(), accountId: c.accountId,
      expectedVersion: c.lastSequence, decision, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...(predecessorId ? { predecessorId } : {}) } });
  };
  const proposeTransaction = (txn: OverlapViewModel, decision: "duplicate" | "unique" | "reopen", originalTxnId?: string) => {
    setConfirmation({ label: decision === "duplicate" ? `Count this purchase once by keeping the previous record? ${txn.label}`
      : decision === "unique" ? `Count this as a separate transaction? This changes spending totals. ${txn.label}`
      : `Undo this review and leave the new record out of totals until reviewed again? ${txn.label}`,
    command: { kind: "transaction", commandId: Crypto.randomUUID(), txnId: txn.txnId,
      expectedVersion: txn.expectedVersion, continuityVersion: c.lastSequence, decision,
      ...(originalTxnId ? { originalTxnId } : {}) } });
  };
  return <View style={styles.review}>
    <Text style={styles.accountName}>Account history</Text>
    {c.decision === "pending" ? <>
      <Text style={styles.basis}>Is this one of your previous accounts? Names and last four digits alone cannot prove a match. Its imported spending is not counted until you choose.</Text>
      {history.candidates.map((candidate) => <View key={candidate.accountId}>
        <Text style={styles.meta}>{candidate.label} · {candidate.lastSyncedAt ? `Last complete update: ${new Date(candidate.lastSyncedAt).toLocaleString()}` : "Last complete update unknown — all imported transactions will need review"}</Text>
        <ReviewButton disabled={busy || !onSave} label={`Same account: ${candidate.label}`} onPress={() => proposeAccount("same", `Keep ${candidate.label}'s old history and use only this connection's current balance? Overlapping transactions will stay out of totals until reviewed.`, candidate.accountId)} />
      </View>)}
      <ReviewButton disabled={busy || !onSave} label="This is a different account" onPress={() => proposeAccount("different", "Treat this as a separate account and count its imported transactions independently?")} />
    </> : <>
      <Text style={styles.basis}>{c.decision === "same" ? `Continues ${history.predecessorLabel ?? "previous account"}. ${c.cutoffDate ? `Imports dated ${c.cutoffDate} or earlier need review (including that whole day).` : "No reliable handoff date: imported transactions need review."}` : "Confirmed as a separate account."}</Text>
      <ReviewButton disabled={busy || !onSave} label="Change account decision" onPress={() => proposeAccount("reopen", "Reopen this account decision? Its imported spending will be excluded until you confirm again.")} />
      {history.transactions.slice(0, visible).map((txn) => <View key={txn.txnId} style={styles.review}>
        <Text style={styles.basis}>{txn.label}</Text>
        <Text style={styles.meta}>{txn.statusLabel}</Text>
        {txn.needsReview && <>
          <MatchChoices txn={txn} disabled={busy || !onSave} onChoose={(id) => proposeTransaction(txn, "duplicate", id)} />
          <ReviewButton disabled={busy || !onSave} label="Count as a separate transaction" onPress={() => proposeTransaction(txn, "unique")} />
        </>}
        {txn.canUndo && <ReviewButton disabled={busy || !onSave} label="Undo transaction review" onPress={() => proposeTransaction(txn, "reopen")} />}
      </View>)}
      {history.transactions.length > visible && <ReviewButton label="Show more transactions" onPress={() => setVisible(visible + 10)} />}
    </>}
    {confirmation && <View style={styles.review}>
      <Text style={styles.basis}>{confirmation.label}</Text>
      <ReviewButton disabled={busy || !onSave} label={busy ? "Saving…" : "Confirm"} onPress={() => {
        if (!onSave) return;
        setBusy(true); setError(undefined);
        void onSave(confirmation.command).then(() => setConfirmation(undefined))
          .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not save. Please try again."))
          .finally(() => setBusy(false));
      }} />
      <ReviewButton disabled={busy} label="Cancel" onPress={() => { setConfirmation(undefined); setError(undefined); }} />
    </View>}
    {error && <Text accessibilityRole="alert" style={styles.disconnectText}>{error}</Text>}
  </View>;
}

function MatchChoices({ txn, disabled, onChoose }: { txn: OverlapViewModel; disabled: boolean; onChoose(id: string): void }) {
  const [visible, setVisible] = useState(5);
  return <>{txn.candidates.slice(0, visible).map((candidate) => <ReviewButton key={candidate.txnId}
    disabled={disabled} label={`Match to: ${candidate.label}`} onPress={() => onChoose(candidate.txnId)} />)}
    {txn.candidates.length > visible && <ReviewButton label="Show more possible matches" onPress={() => setVisible(visible + 5)} />}</>;
}

function ReviewButton({ label, disabled, onPress }: { label: string; disabled?: boolean; onPress(): void }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} disabled={disabled}
    style={styles.disconnectButton} onPress={onPress}><Text style={[styles.capacity, disabled && { opacity: 0.5 }]}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  review: { marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: theme.divider },
  screen: { flex: 1, backgroundColor: theme.bg },
  content: { paddingTop: 72, paddingHorizontal: 20, paddingBottom: 28 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { fontSize: 24, fontWeight: "800", color: theme.ink },
  subtitle: { color: theme.slate, fontSize: 12, marginTop: 2 },
  addButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  group: { marginTop: 24 },
  groupHeader: { flexDirection: "row", alignItems: "center", gap: 7, marginBottom: 9 },
  groupTitle: { fontSize: 15, fontWeight: "700", color: theme.ink },
  connectionStatus: { marginLeft: "auto", fontSize: 11, fontWeight: "700", color: theme.slate },
  message: { color: theme.slate, fontSize: 12, marginBottom: 8 },
  card: {
    backgroundColor: theme.card,
    borderRadius: 15,
    padding: 15,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: theme.divider,
  },
  row: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  accountText: { flex: 1 },
  accountName: { fontSize: 15, fontWeight: "700", color: theme.ink },
  balance: { fontSize: 16, fontWeight: "800", color: theme.ink },
  capacity: { marginTop: 9, fontSize: 13, fontWeight: "700", color: theme.primaryDark },
  basis: { marginTop: 3, fontSize: 12, color: theme.slate },
  meta: { marginTop: 4, fontSize: 11, color: theme.faint },
  empty: { alignItems: "center", marginTop: 80 },
  emptyTitle: { color: theme.ink, fontSize: 18, fontWeight: "700" },
  emptyButton: { marginTop: 18, backgroundColor: theme.primary, paddingVertical: 12, paddingHorizontal: 20, borderRadius: 12 },
  emptyButtonText: { color: theme.onPrimary, fontWeight: "700" },
  disconnectButton: { alignSelf: "flex-start", paddingVertical: 8, paddingHorizontal: 2 },
  disconnectText: { color: "#A33A32", fontSize: 12, fontWeight: "700" },
});
