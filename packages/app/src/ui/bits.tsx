/**
 * Shared UI atoms matching docs/uiDesign/image2.png: category icon chips,
 * transaction rows, stat tiles. Ionicons ships inside the expo package —
 * no added dependency.
 */
import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import type { DashboardTxn } from "../data/dashboardModel";
import { humanizeCategory, iconSpecFor } from "./categoryDisplay";
import { theme } from "./theme";

type IconName = keyof typeof Ionicons.glyphMap;

/**
 * Merchant logo when we have one, category icon otherwise.
 *
 * Fallback is TWO-STAGE on purpose: a URL existing doesn't mean the image
 * loads — the host can 404, the network can drop, the format can be
 * unsupported. `onError` catches that at runtime and swaps in the drawn
 * icon, so a row never renders as an empty box.
 */
export function CategoryIcon({ category, logoUrl }: { category?: string; logoUrl?: string }) {
  const [logoFailed, setLogoFailed] = useState(false);
  const spec = iconSpecFor(category);

  if (logoUrl && !logoFailed) {
    return (
      <View style={[styles.iconChip, styles.logoChip]}>
        <Image
          source={{ uri: logoUrl }}
          style={styles.logo}
          onError={() => setLogoFailed(true)}
          accessibilityIgnoresInvertColors
        />
      </View>
    );
  }

  return (
    <View style={[styles.iconChip, { backgroundColor: spec.bg }]}>
      {/* categoryDisplay.ts is platform-free, so glyph names are typed as
          string there; this is the one place they meet the icon set. */}
      <Ionicons name={spec.icon as IconName} size={18} color={spec.fg} />
    </View>
  );
}

export function TxnRow({ txn, onPress }: { txn: DashboardTxn; onPress?: (txnId: string) => void }) {
  return (
    <Pressable
      style={styles.txnRow}
      onPress={onPress ? () => onPress(txn.txnId) : undefined}
      disabled={!onPress}
    >
      <CategoryIcon
        {...(txn.category !== undefined ? { category: txn.category } : {})}
        {...(txn.logoUrl !== undefined ? { logoUrl: txn.logoUrl } : {})}
      />
      <View style={styles.txnBody}>
        <Text style={styles.txnMerchant} numberOfLines={1}>
          {txn.merchant}
          {txn.pending ? "  (pending)" : ""}
        </Text>
        {txn.category ? (
          <Text style={styles.txnCategory}>{humanizeCategory(txn.category)}</Text>
        ) : null}
      </View>
      <Text style={[styles.txnAmount, { color: txn.isInflow ? theme.inflow : theme.outflow }]}>
        {txn.amountFormatted}
      </Text>
    </Pressable>
  );
}

export function StatTile(props: { label: string; value: string; up: boolean }) {
  return (
    <View style={styles.statTile}>
      <View style={styles.statHeader}>
        <Text style={styles.statLabel}>{props.label}</Text>
        <View
          style={[
            styles.statArrow,
            { backgroundColor: props.up ? "#dcfce7" : "#fee2e2" },
          ]}
        >
          <Ionicons
            name={props.up ? "arrow-up" : "arrow-down"}
            size={12}
            color={props.up ? theme.primaryDark : theme.outflow}
          />
        </View>
      </View>
      <Text style={styles.statValue}>{props.value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  iconChip: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  // Neutral plate behind logos: merchant art is usually transparent PNG and
  // would otherwise disappear against a tinted category background.
  logoChip: { backgroundColor: theme.card, borderWidth: 1, borderColor: theme.divider },
  logo: { width: 26, height: 26, borderRadius: 6, resizeMode: "contain" },
  txnRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10 },
  txnBody: { flex: 1, marginHorizontal: 12 },
  txnMerchant: { fontSize: 15, fontWeight: "600", color: theme.ink },
  txnCategory: { fontSize: 12, color: theme.slate, marginTop: 2 },
  txnAmount: { fontSize: 15, fontWeight: "700" },
  statTile: {
    flex: 1,
    backgroundColor: theme.card,
    borderRadius: 14,
    padding: 14,
  },
  statHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  statLabel: { fontSize: 12, color: theme.slate },
  statArrow: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  statValue: { fontSize: 18, fontWeight: "800", color: theme.ink, marginTop: 6 },
});
