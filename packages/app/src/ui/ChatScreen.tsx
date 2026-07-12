/**
 * Copilot chat (docs/copilotArchitecture.md). Asks the server, which routes to
 * a deterministic tool and phrases the computed result under the faithfulness
 * leash. The UI is a dumb transcript: it shows whatever verified answer comes
 * back, tagged with how it was produced.
 */
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { ChatMessage } from "../data/chat";
import type { SyncTransport } from "../data/syncClient";
import { theme } from "./theme";

const SUGGESTIONS = [
  "How much did I spend last month?",
  "What's my available cash?",
  "What bills are due soon?",
];

export function ChatScreen(props: { transport: SyncTransport; onBack: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const idRef = useRef(0);
  const nextId = () => `m-${++idRef.current}`;

  const send = useCallback(
    async (text: string) => {
      const question = text.trim();
      if (!question || busy || !props.transport.chat) return;
      setInput("");
      setBusy(true);
      const userMsg: ChatMessage = { id: nextId(), role: "user", text: question };
      const pending: ChatMessage = { id: nextId(), role: "assistant", text: "", pending: true };
      setMessages((m) => [...m, userMsg, pending]);

      try {
        const todayLocal = new Date().toISOString().slice(0, 10);
        const answer = await props.transport.chat(question, todayLocal);
        setMessages((m) =>
          m.map((msg) =>
            msg.id === pending.id
              ? { ...msg, text: answer.answer, source: answer.source, pending: false }
              : msg,
          ),
        );
      } catch {
        setMessages((m) =>
          m.map((msg) =>
            msg.id === pending.id
              ? { ...msg, text: "The copilot is unavailable right now. Try again in a moment.", pending: false }
              : msg,
          ),
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, props.transport],
  );

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header}>
        <Pressable onPress={props.onBack} hitSlop={12}>
          <Ionicons name="chevron-back" size={24} color={theme.ink} />
        </Pressable>
        <View style={styles.headerTitleWrap}>
          <Ionicons name="sparkles" size={16} color={theme.primary} />
          <Text style={styles.title}>Copilot</Text>
        </View>
        <View style={{ width: 24 }} />
      </View>

      {messages.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>Ask about your money</Text>
          <Text style={styles.emptySub}>
            Grounded in your real data — every number is computed, never guessed.
          </Text>
          {SUGGESTIONS.map((s) => (
            <Pressable key={s} style={styles.suggestion} onPress={() => send(s)}>
              <Text style={styles.suggestionText}>{s}</Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <FlatList
          style={styles.list}
          contentContainerStyle={styles.listContent}
          data={messages}
          keyExtractor={(m) => m.id}
          renderItem={({ item }) => <Bubble message={item} />}
        />
      )}

      <View style={styles.inputBar}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Ask a question…"
          placeholderTextColor={theme.faint}
          onSubmitEditing={() => send(input)}
          returnKeyType="send"
          editable={!busy}
        />
        <Pressable
          style={[styles.sendBtn, (busy || !input.trim()) && styles.sendBtnDisabled]}
          onPress={() => send(input)}
          disabled={busy || !input.trim()}
        >
          <Ionicons name="arrow-up" size={20} color={theme.onPrimary} />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

function Bubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <View style={[styles.bubbleRow, isUser ? styles.rowRight : styles.rowLeft]}>
      <View style={[styles.bubble, isUser ? styles.userBubble : styles.aiBubble]}>
        {message.pending ? (
          <ActivityIndicator color={theme.primary} />
        ) : (
          <>
            <Text style={[styles.bubbleText, isUser && styles.userText]}>{message.text}</Text>
            {message.source === "template" && (
              <Text style={styles.trace}>computed directly from your data</Text>
            )}
            {message.source === "llm" && (
              <Text style={styles.trace}>✓ verified against your data</Text>
            )}
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg, paddingTop: 64 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    marginBottom: 8,
  },
  headerTitleWrap: { flexDirection: "row", alignItems: "center", gap: 6 },
  title: { fontSize: 18, fontWeight: "800", color: theme.ink },
  empty: { flex: 1, paddingHorizontal: 24, justifyContent: "center" },
  emptyTitle: { fontSize: 20, fontWeight: "800", color: theme.ink, textAlign: "center" },
  emptySub: { fontSize: 13, color: theme.slate, textAlign: "center", marginTop: 8, marginBottom: 24 },
  suggestion: {
    backgroundColor: theme.card,
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: theme.divider,
  },
  suggestionText: { fontSize: 14, color: theme.ink },
  list: { flex: 1 },
  listContent: { paddingHorizontal: 16, paddingBottom: 12 },
  bubbleRow: { marginVertical: 5, flexDirection: "row" },
  rowRight: { justifyContent: "flex-end" },
  rowLeft: { justifyContent: "flex-start" },
  bubble: { maxWidth: "82%", borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10 },
  userBubble: { backgroundColor: theme.primary, borderBottomRightRadius: 4 },
  aiBubble: { backgroundColor: theme.card, borderBottomLeftRadius: 4, borderWidth: 1, borderColor: theme.divider },
  bubbleText: { fontSize: 15, color: theme.ink, lineHeight: 21 },
  userText: { color: theme.onPrimary },
  trace: { fontSize: 11, color: theme.slate, marginTop: 6 },
  inputBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 28,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.divider,
    backgroundColor: theme.card,
  },
  input: {
    flex: 1,
    backgroundColor: theme.bg,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15,
    color: theme.ink,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtnDisabled: { backgroundColor: theme.faint },
});
