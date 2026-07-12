/**
 * Bottom tab bar per docs/uiDesign/image2.png: Home · Transactions · [FAB]
 * · Budget · Reports. Deliberate deviation: the mockup's center "+" adds a
 * transaction (that moved to the Transactions screen); ours opens the Copilot
 * chat (docs/copilotArchitecture.md) — the conversational assistant is the
 * product's differentiator and earns the primary action. "Can I buy this?"
 * lives on the Home hero card. Reports renders a placeholder until its milestone.
 */
import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "./theme";

export type Tab = "home" | "transactions" | "budget" | "reports";

const TABS: { key: Tab; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: "home", label: "Home", icon: "home" },
  { key: "transactions", label: "Transactions", icon: "swap-horizontal" },
  { key: "budget", label: "Budget", icon: "wallet" },
  { key: "reports", label: "Reports", icon: "bar-chart" },
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
