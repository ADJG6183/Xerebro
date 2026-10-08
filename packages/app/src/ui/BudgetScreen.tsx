/**
 * Budget (docs/uiDesign/image2.png screen 3): buckets with progress toward
 * targets, and upcoming bills. Add forms are inline toggles. These are the
 * same numbers "Can I buy this?" reads — buckets reserve cash, bills are the
 * 30-day obligations — so editing here changes the verdict there.
 */
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { PlanViewModel } from "../data/planModel";
import { parseDollarsToMinor, parseLocalDate } from "../data/money";
import { humanizeCategory } from "./categoryDisplay";
import { LabeledInput, PrimaryButton } from "./forms";
import { theme } from "./theme";

export interface NewBucket {
  name: string;
  allocatedMinor: number;
  targetMinor?: number;
}
export interface NewBill {
  name: string;
  expectedAmountMinor: number;
  nextDue: string;
}
export interface NewBudget {
  categoryId: string;
  limitMinor: number;
}

export function BudgetScreen(props: {
  vm: PlanViewModel;
  onAddBucket: (b: NewBucket) => void;
  onAddBill: (b: NewBill) => void;
  onAddBudget: (b: NewBudget) => void;
  /** Spec §6: "Tapping a row opens scoped spending detail." */
  onOpenCategory: (categoryId: string) => void;
}) {
  const [adding, setAdding] = useState<"none" | "bucket" | "bill" | "budget">("none");
  const { vm } = props;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Budget</Text>

      <SectionHeader
        title="Monthly limits"
        meta={vm.budgets.length > 0 ? `for ${vm.budgetMonth}` : "no limits set yet"}
        onAdd={() => setAdding(adding === "budget" ? "none" : "budget")}
      />
      {adding === "budget" && (
        <BudgetForm
          onSubmit={(b) => {
            props.onAddBudget(b);
            setAdding("none");
          }}
        />
      )}
      <View style={styles.card}>
        {vm.budgets.length === 0 ? (
          <Text style={styles.empty}>
            No monthly limits yet. A limit compares your spending to a target — it never
            reserves cash the way a bucket does.
          </Text>
        ) : (
          vm.budgets.map((b) => (
            <Pressable key={b.budgetPlanId} onPress={() => props.onOpenCategory(b.categoryId)}>
              <View style={styles.bucketRow}>
                <View style={styles.bucketTop}>
                  <Text style={styles.rowName}>{humanizeCategory(b.categoryId)}</Text>
                  <Text style={[styles.rowAmount, b.overLimit && styles.overLimitText]}>
                    {b.spentFormatted} / {b.limitFormatted}
                  </Text>
                </View>
                <View style={styles.track}>
                  <View
                    style={[
                      styles.fill,
                      b.overLimit && styles.fillOver,
                      { width: `${Math.min(100, b.progressPercent)}%` },
                    ]}
                  />
                </View>
                <Text style={[styles.remainingLabel, b.overLimit && styles.overLimitText]}>
                  {b.overLimit ? `${b.remainingFormatted} over` : `${b.remainingFormatted} remaining`}
                  {b.pendingFormatted ? ` · ${b.pendingFormatted} pending` : ""}
                  {!b.enabled ? " · tracking off" : ""}
                </Text>
              </View>
            </Pressable>
          ))
        )}
      </View>

      <SectionHeader
        title="Reserved savings"
        meta={`${vm.totalAllocatedFormatted} allocated`}
        onAdd={() => setAdding(adding === "bucket" ? "none" : "bucket")}
      />
      {adding === "bucket" && (
        <BucketForm
          onSubmit={(b) => {
            props.onAddBucket(b);
            setAdding("none");
          }}
        />
      )}
      <View style={styles.card}>
        {vm.buckets.length === 0 ? (
          <Text style={styles.empty}>No buckets yet. Buckets reserve cash for a purpose.</Text>
        ) : (
          vm.buckets.map((b) => (
            <View key={b.bucketId} style={styles.bucketRow}>
              <View style={styles.bucketTop}>
                <Text style={styles.rowName}>{b.name}</Text>
                <Text style={styles.rowAmount}>
                  {b.allocatedFormatted}
                  {b.targetFormatted ? ` / ${b.targetFormatted}` : ""}
                </Text>
              </View>
              {b.progressPercent !== undefined && (
                <View style={styles.track}>
                  <View style={[styles.fill, { width: `${b.progressPercent}%` }]} />
                </View>
              )}
            </View>
          ))
        )}
      </View>

      <SectionHeader
        title="Upcoming Bills"
        meta={`${vm.upcoming30dFormatted} in 30 days`}
        onAdd={() => setAdding(adding === "bill" ? "none" : "bill")}
      />
      {adding === "bill" && (
        <BillForm
          onSubmit={(b) => {
            props.onAddBill(b);
            setAdding("none");
          }}
        />
      )}
      <View style={styles.card}>
        {vm.bills.length === 0 ? (
          <Text style={styles.empty}>No bills yet. Bills feed the "Can I buy this?" math.</Text>
        ) : (
          vm.bills.map((b) => (
            <View key={b.billId} style={styles.billRow}>
              <View style={styles.iconChip}>
                <Ionicons name="calendar-outline" size={18} color={theme.primaryDeep} />
              </View>
              <View style={styles.billBody}>
                <Text style={styles.rowName}>{b.name}</Text>
                <Text style={[styles.dueLabel, b.soon && styles.dueSoon]}>{b.dueLabel}</Text>
              </View>
              <Text style={styles.rowAmount}>{b.amountFormatted}</Text>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}

function SectionHeader(props: { title: string; meta: string; onAdd: () => void }) {
  return (
    <View style={styles.sectionHeader}>
      <View>
        <Text style={styles.sectionTitle}>{props.title}</Text>
        <Text style={styles.sectionMeta}>{props.meta}</Text>
      </View>
      <Pressable style={styles.addBtn} onPress={props.onAdd} hitSlop={8}>
        <Ionicons name="add" size={20} color={theme.primary} />
      </Pressable>
    </View>
  );
}

function BudgetForm({ onSubmit }: { onSubmit: (b: NewBudget) => void }) {
  const [category, setCategory] = useState("");
  const [limit, setLimit] = useState("");
  const limitMinor = parseDollarsToMinor(limit);
  const valid = category.trim() !== "" && limitMinor !== null && limitMinor > 0;

  return (
    <View style={styles.form}>
      <LabeledInput
        label="Category"
        value={category}
        onChangeText={setCategory}
        placeholder="Dining"
        autoFocus
      />
      <LabeledInput
        label="Monthly limit"
        value={limit}
        onChangeText={setLimit}
        placeholder="$400.00"
        keyboardType="numbers-and-punctuation"
        invalid={limit.length > 0 && (limitMinor === null || limitMinor <= 0)}
      />
      <PrimaryButton
        label="Save limit"
        disabled={!valid}
        onPress={() => valid && onSubmit({ categoryId: category.trim(), limitMinor: limitMinor! })}
      />
    </View>
  );
}

function BucketForm({ onSubmit }: { onSubmit: (b: NewBucket) => void }) {
  const [name, setName] = useState("");
  const [allocated, setAllocated] = useState("");
  const [target, setTarget] = useState("");
  const allocatedMinor = parseDollarsToMinor(allocated);
  const targetMinor = target.trim() === "" ? undefined : parseDollarsToMinor(target);
  const valid = name.trim() !== "" && allocatedMinor !== null && targetMinor !== null;

  return (
    <View style={styles.form}>
      <LabeledInput label="Bucket name" value={name} onChangeText={setName} placeholder="Emergency Fund" autoFocus />
      <LabeledInput
        label="Allocated now"
        value={allocated}
        onChangeText={setAllocated}
        placeholder="$0.00"
        keyboardType="numbers-and-punctuation"
        invalid={allocated.length > 0 && allocatedMinor === null}
      />
      <LabeledInput
        label="Target (optional)"
        value={target}
        onChangeText={setTarget}
        placeholder="$5,000.00"
        keyboardType="numbers-and-punctuation"
        invalid={target.length > 0 && targetMinor === null}
      />
      <PrimaryButton
        label="Save bucket"
        disabled={!valid}
        onPress={() =>
          valid &&
          onSubmit({
            name: name.trim(),
            allocatedMinor: allocatedMinor!,
            ...(targetMinor !== undefined ? { targetMinor } : {}),
          })
        }
      />
    </View>
  );
}

function BillForm({ onSubmit }: { onSubmit: (b: NewBill) => void }) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [due, setDue] = useState("");
  const amountMinor = parseDollarsToMinor(amount);
  const dueValid = parseLocalDate(due) !== null;
  const valid = name.trim() !== "" && amountMinor !== null && amountMinor > 0 && dueValid;

  return (
    <View style={styles.form}>
      <LabeledInput label="Bill name" value={name} onChangeText={setName} placeholder="Electricity" autoFocus />
      <LabeledInput
        label="Expected amount"
        value={amount}
        onChangeText={setAmount}
        placeholder="$0.00"
        keyboardType="numbers-and-punctuation"
        invalid={amount.length > 0 && (amountMinor === null || amountMinor <= 0)}
      />
      <LabeledInput
        label="Next due date"
        value={due}
        onChangeText={setDue}
        placeholder="YYYY-MM-DD"
        keyboardType="numbers-and-punctuation"
        invalid={due.length > 0 && !dueValid}
      />
      <PrimaryButton
        label="Save bill"
        disabled={!valid}
        onPress={() => valid && onSubmit({ name: name.trim(), expectedAmountMinor: amountMinor!, nextDue: due })}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  content: { paddingTop: 72, paddingHorizontal: 20, paddingBottom: 32 },
  title: { fontSize: 20, fontWeight: "800", color: theme.ink, textAlign: "center", marginBottom: 16 },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 18,
    marginBottom: 10,
  },
  sectionTitle: { fontSize: 16, fontWeight: "700", color: theme.ink },
  sectionMeta: { fontSize: 12, color: theme.slate, marginTop: 2 },
  addBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: theme.chipBg,
    alignItems: "center",
    justifyContent: "center",
  },
  card: { backgroundColor: theme.card, borderRadius: 16, padding: 14 },
  form: { backgroundColor: theme.card, borderRadius: 16, padding: 14, marginBottom: 12 },
  empty: { color: theme.slate, fontSize: 13, paddingVertical: 6 },
  bucketRow: { paddingVertical: 10 },
  bucketTop: { flexDirection: "row", justifyContent: "space-between", marginBottom: 8 },
  rowName: { fontSize: 15, fontWeight: "600", color: theme.ink },
  rowAmount: { fontSize: 14, fontWeight: "700", color: theme.ink },
  track: { height: 8, borderRadius: 4, backgroundColor: theme.chipBg, overflow: "hidden" },
  fill: { height: 8, borderRadius: 4, backgroundColor: theme.primary },
  fillOver: { backgroundColor: theme.outflow },
  overLimitText: { color: theme.outflow },
  remainingLabel: { fontSize: 12, color: theme.slate, marginTop: 6 },
  billRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10 },
  iconChip: {
    width: 40,
    height: 40,
    borderRadius: 12,
    backgroundColor: "#d1fae5",
    alignItems: "center",
    justifyContent: "center",
  },
  billBody: { flex: 1, marginHorizontal: 12 },
  dueLabel: { fontSize: 12, color: theme.slate, marginTop: 2 },
  dueSoon: { color: theme.amber, fontWeight: "600" },
});
