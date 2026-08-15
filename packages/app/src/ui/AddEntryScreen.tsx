/**
 * Manual entry (docs/V1Scope.md: manual accounts + transactions). Two modes:
 * create an account, or log a transaction against one. All money crosses the
 * integer boundary here via parseDollarsToMinor — no floats past this screen.
 */
import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { parseDollarsToMinor, parseLocalDate } from "../data/money";
import { LabeledInput, PrimaryButton, SegmentedRow } from "./forms";
import { theme } from "./theme";

export interface NewAccount {
  name: string;
  openingBalanceMinor: number;
}
export interface NewTransaction {
  accountId: string;
  amountMinor: number; // signed: negative outflow
  merchant: string;
  category: string;
  postedDate: string;
}

export function AddEntryScreen(props: {
  accounts: { accountId: string; name: string }[];
  todayLocal: string;
  onSubmitAccount: (a: NewAccount) => void;
  onSubmitTransaction: (t: NewTransaction) => void;
  onBack: () => void;
  /** Bank linking (docs/SecurityPrivacy.md). Absent = manual-only build. */
  onLinkBank?: () => void;
  linking?: boolean;
  linkNotice?: string;
}) {
  const hasAccounts = props.accounts.length > 0;
  const [mode, setMode] = useState<"account" | "transaction">(
    hasAccounts ? "transaction" : "account",
  );

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Pressable onPress={props.onBack} hitSlop={12}>
          <Ionicons name="chevron-back" size={24} color={theme.ink} />
        </Pressable>
        <Text style={styles.title}>Add</Text>
        <View style={{ width: 24 }} />
      </View>

      {hasAccounts && (
        <SegmentedRow
          label="What are you adding?"
          value={mode}
          onChange={setMode}
          options={[
            { key: "transaction", label: "Transaction" },
            { key: "account", label: "Account" },
          ]}
        />
      )}

      {mode === "account" ? (
        <View>
          {props.onLinkBank && (
            <View style={styles.linkBlock}>
              <Pressable
                style={[styles.linkBtn, props.linking && styles.linkBtnBusy]}
                onPress={props.onLinkBank}
                disabled={props.linking}
              >
                <Ionicons name="business-outline" size={18} color={theme.onPrimary} />
                <Text style={styles.linkBtnText}>
                  {props.linking ? "Opening your bank…" : "Connect a bank"}
                </Text>
              </Pressable>
              <Text style={styles.linkHint}>
                Your bank credentials go to Plaid, never to Xerebro.
              </Text>
              {props.linkNotice ? <Text style={styles.linkNotice}>{props.linkNotice}</Text> : null}
              <Text style={styles.orDivider}>or add one manually</Text>
            </View>
          )}
          <AccountForm onSubmit={props.onSubmitAccount} />
        </View>
      ) : (
        <TransactionForm
          accounts={props.accounts}
          todayLocal={props.todayLocal}
          onSubmit={props.onSubmitTransaction}
        />
      )}
    </ScrollView>
  );
}

function AccountForm({ onSubmit }: { onSubmit: (a: NewAccount) => void }) {
  const [name, setName] = useState("");
  const [balance, setBalance] = useState("");
  const openingBalanceMinor = parseDollarsToMinor(balance);
  const valid = name.trim().length > 0 && openingBalanceMinor !== null;

  return (
    <View>
      <LabeledInput label="Account name" value={name} onChangeText={setName} placeholder="My Checking" autoFocus />
      <LabeledInput
        label="Current balance"
        value={balance}
        onChangeText={setBalance}
        placeholder="$0.00"
        keyboardType="numbers-and-punctuation"
        invalid={balance.length > 0 && openingBalanceMinor === null}
      />
      <PrimaryButton
        label="Add account"
        disabled={!valid}
        onPress={() => valid && onSubmit({ name: name.trim(), openingBalanceMinor: openingBalanceMinor! })}
      />
    </View>
  );
}

function TransactionForm(props: {
  accounts: { accountId: string; name: string }[];
  todayLocal: string;
  onSubmit: (t: NewTransaction) => void;
}) {
  const [accountId, setAccountId] = useState(props.accounts[0]?.accountId ?? "");
  const [direction, setDirection] = useState<"expense" | "income">("expense");
  const [amount, setAmount] = useState("");
  const [merchant, setMerchant] = useState("");
  const [category, setCategory] = useState("");
  const [date, setDate] = useState(props.todayLocal);

  const magnitude = parseDollarsToMinor(amount);
  const dateValid = parseLocalDate(date) !== null;
  const valid = accountId !== "" && magnitude !== null && magnitude > 0 && merchant.trim().length > 0 && dateValid;

  const accountOptions = useMemo(
    () => props.accounts.map((a) => ({ key: a.accountId, label: a.name })),
    [props.accounts],
  );

  return (
    <View>
      {accountOptions.length > 1 && (
        <SegmentedRow label="Account" value={accountId} onChange={setAccountId} options={accountOptions} />
      )}
      <SegmentedRow
        label="Type"
        value={direction}
        onChange={setDirection}
        options={[
          { key: "expense", label: "Expense" },
          { key: "income", label: "Income" },
        ]}
      />
      <LabeledInput
        label="Amount"
        value={amount}
        onChangeText={setAmount}
        placeholder="$0.00"
        keyboardType="numbers-and-punctuation"
        invalid={amount.length > 0 && (magnitude === null || magnitude <= 0)}
        autoFocus
      />
      <LabeledInput label="Merchant" value={merchant} onChangeText={setMerchant} placeholder="Grocery Store" />
      <LabeledInput label="Category" value={category} onChangeText={setCategory} placeholder="Groceries" />
      <LabeledInput
        label="Date"
        value={date}
        onChangeText={setDate}
        placeholder="YYYY-MM-DD"
        keyboardType="numbers-and-punctuation"
        invalid={date.length > 0 && !dateValid}
      />
      <PrimaryButton
        label="Add transaction"
        disabled={!valid}
        onPress={() =>
          valid &&
          props.onSubmit({
            accountId,
            amountMinor: direction === "expense" ? -magnitude! : magnitude!,
            merchant: merchant.trim(),
            category: category.trim(),
            postedDate: date,
          })
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  content: { paddingTop: 64, paddingHorizontal: 20, paddingBottom: 40 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 20,
  },
  title: { fontSize: 18, fontWeight: "800", color: theme.ink },
  linkBlock: { marginBottom: 18 },
  linkBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: theme.primaryDeep,
    borderRadius: 12,
    paddingVertical: 15,
  },
  linkBtnBusy: { opacity: 0.6 },
  linkBtnText: { color: theme.onPrimary, fontWeight: "700", fontSize: 15 },
  linkHint: { fontSize: 12, color: theme.slate, textAlign: "center", marginTop: 8 },
  linkNotice: { fontSize: 12, color: theme.amber, textAlign: "center", marginTop: 6 },
  orDivider: { fontSize: 12, color: theme.faint, textAlign: "center", marginTop: 14 },
});
