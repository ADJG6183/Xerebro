/**
 * Bottom tab bar per docs/uiDesign/image2.png: Home · Spending · [FAB] ·
 * Budget · Accounts. "Transactions" evolved into "Spending" (summaries +
 * complete-history detail, rocketMoneyMvpSpec.md §12, approved 2026-10-07).
 * Bills becomes its own fifth destination in a later stage (§11 stage 3),
 * not yet split out of Budget here. Deliberate deviation from the mockup:
 * its center "+" adds a transaction (that moved to the Spending screen);
 * ours opens the Copilot chat (docs/copilotArchitecture.md) — the
 * conversational assistant is the product's differentiator and earns the
 * primary action. "Can I buy this?" lives on the Home hero card.
 */
import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "./theme";

export type Tab = "home" | "spending" | "budget" | "accounts";

const TABS: { key: Tab; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: "home", label: "Home", icon: "home" },
  { key: "spending", label: "Spending", icon: "swap-horizontal" },
  { key: "budget", label: "Budget", icon: "wallet" },
  { key: "accounts", label: "Accounts", icon: "card" },
];

export function TabBar(props: { active: Tab; onTab: (t: Tab) => void; onAsk: () => void }) {
  const [left, right] = [TABS.slice(0, 2), TABS.slice(2)];
  const renderTab = (t: (typeof TABS)[number]) => (
    <Pressable key={t.key} style={styles.tab} onPress={() => props.onTab(t.key)}>
      <Ionicons
        name={props.active === t.key ? t.icon : (`${t.icon}-outline` as never)}
        size={22}
        color={props.active === t.key ? theme.primary : theme.faint}
      />
      <Text style={[styles.tabLabel, props.active === t.key && { color: theme.primary }]}>
        {t.label}
      </Text>
    </Pressable>
  );

  return (
    <View style={styles.bar}>
      {left.map(renderTab)}
      <Pressable style={styles.fab} onPress={props.onAsk}>
        <Ionicons name="sparkles" size={24} color={theme.onPrimary} />
      </Pressable>
      {right.map(renderTab)}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    backgroundColor: theme.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.divider,
    paddingTop: 8,
    paddingBottom: 24,
    paddingHorizontal: 8,
  },
  tab: { alignItems: "center", width: 76 },
  tabLabel: { fontSize: 10, color: theme.faint, marginTop: 2 },
  fab: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
    marginTop: -28,
    shadowColor: theme.primaryDeep,
    shadowOpacity: 0.35,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
});
