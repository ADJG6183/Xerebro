/**
 * Reusable form atoms for manual entry. Validation lives in the data layer
 * (parseDollarsToMinor / parseLocalDate); these just present it.
 */
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { theme } from "./theme";

export function LabeledInput(props: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  keyboardType?: "default" | "decimal-pad" | "numbers-and-punctuation";
  invalid?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{props.label}</Text>
      <TextInput
        style={[styles.input, props.invalid && styles.inputInvalid]}
        value={props.value}
        onChangeText={props.onChangeText}
        placeholder={props.placeholder}
        placeholderTextColor={theme.faint}
        keyboardType={props.keyboardType ?? "default"}
        autoFocus={props.autoFocus}
        autoCapitalize="words"
      />
    </View>
  );
}

export function SegmentedRow<T extends string>(props: {
  label: string;
  options: { key: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{props.label}</Text>
      <View style={styles.segments}>
        {props.options.map((o) => (
          <Pressable
            key={o.key}
            style={[styles.segment, props.value === o.key && styles.segmentActive]}
            onPress={() => props.onChange(o.key)}
          >
            <Text style={[styles.segmentText, props.value === o.key && styles.segmentTextActive]}>
              {o.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export function PrimaryButton(props: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      style={[styles.button, props.disabled && styles.buttonDisabled]}
      onPress={props.onPress}
      disabled={props.disabled}
    >
      <Text style={styles.buttonText}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  field: { marginBottom: 14 },
  label: { fontSize: 13, fontWeight: "600", color: theme.slate, marginBottom: 6 },
  input: {
    backgroundColor: theme.card,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: theme.ink,
    borderWidth: 1,
    borderColor: theme.divider,
  },
  inputInvalid: { borderColor: theme.outflow },
  segments: { flexDirection: "row", gap: 8 },
  segment: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: theme.chipBg,
    alignItems: "center",
  },
  segmentActive: { backgroundColor: theme.primary },
  segmentText: { fontSize: 13, fontWeight: "600", color: theme.slate },
  segmentTextActive: { color: theme.onPrimary },
  button: {
    backgroundColor: theme.primary,
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: "center",
    marginTop: 4,
  },
  buttonDisabled: { backgroundColor: theme.faint },
  buttonText: { color: theme.onPrimary, fontWeight: "700", fontSize: 15 },
});
