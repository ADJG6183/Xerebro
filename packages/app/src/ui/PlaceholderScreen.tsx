/**
 * Honest placeholder for tabs whose milestones haven't shipped (V1Scope.md
 * defers budget + reports). Present in the tab bar so the mockup's shape is
 * real, but never pretending to have data.
 */
import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";
import { theme } from "./theme";

export function PlaceholderScreen(props: { title: string; note: string }) {
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>{props.title}</Text>
      <View style={styles.card}>
        <Ionicons name="construct-outline" size={28} color={theme.faint} />
        <Text style={styles.note}>{props.note}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg, paddingTop: 72, paddingHorizontal: 20 },
  title: { fontSize: 20, fontWeight: "800", color: theme.ink, marginBottom: 14, textAlign: "center" },
  card: {
    backgroundColor: theme.card,
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
    gap: 10,
  },
  note: { color: theme.slate, fontSize: 13, textAlign: "center", lineHeight: 19 },
});
