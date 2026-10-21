import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { cancelSecret, type SecretRow, submitSecret } from "../shared/contracts";

const DONE_TEXT: Record<Exclude<SecretRow["status"], "waiting">, string> = {
  stored: "Saved. The agent has the file path, not the value.",
  cancelled: "You declined to provide this.",
  expired: "No answer in time. The agent can ask again.",
};

export function SecretRequest({ item, theme, layout }: PluginTimelineItemProps<SecretRow>) {
  const { requestId, name, purpose, status, replacing, storage } = item.data;
  const submit = useRpc(submitSecret);
  const cancel = useRpc(cancelSecret);
  // The value lives in this component's state only, and is cleared once it is sent.
  const [value, setValue] = useState("");
  const send = useMutation({
    mutationFn: async () => {
      const reply = await submit({ requestId, value });
      setValue("");
      if (!reply.ok) throw new Error(reply.message ?? "Could not save the secret.");
    },
  });
  const decline = useMutation({ mutationFn: () => cancel({ requestId }) });

  const styles = useMemo(
    () => ({
      card: {
        gap: layout.compact ? 8 : 10,
        padding: layout.compact ? 12 : 14,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      title: { color: theme.colors.foreground, fontWeight: "600" as const },
      muted: { color: theme.colors.foregroundMuted },
      error: { color: theme.colors.statusDanger },
      input: {
        color: theme.colors.foreground,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
      },
      row: { flexDirection: "row" as const, gap: 8 },
      primary: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: theme.colors.accent },
      primaryText: { color: theme.colors.accentForeground, fontWeight: "600" as const },
      secondary: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border },
      secondaryText: { color: theme.colors.foreground },
    }),
    [theme, layout.compact],
  );

  if (status !== "waiting") {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>{name}</Text>
        <Text style={styles.muted}>{DONE_TEXT[status]}</Text>
      </View>
    );
  }

  const busy = send.isPending || decline.isPending;
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{replacing ? `Replace ${name}?` : `The agent needs ${name}`}</Text>
      <Text style={styles.muted}>{purpose}</Text>
      <Text style={styles.muted}>
        {storage === "memory"
          ? "This is kept in the server's memory, not on disk, and is not sent to the chat. It is lost when the server reboots."
          : "This is saved to a protected file on the server and is not sent to the chat."}
      </Text>
      <TextInput
        accessibilityLabel={`Value for ${name}`}
        style={styles.input}
        value={value}
        onChangeText={setValue}
        placeholder="Paste or type the secret"
        placeholderTextColor={theme.colors.foregroundMuted}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        textContentType="none"
        importantForAutofill="no"
        editable={!busy}
      />
      {send.error ? <Text style={styles.error}>{send.error.message}</Text> : null}
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Save ${name}`}
          disabled={busy || value.length === 0}
          onPress={() => send.mutate()}
          style={[styles.primary, busy || value.length === 0 ? { opacity: 0.5 } : null]}
        >
          <Text style={styles.primaryText}>Save</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Decline to provide ${name}`}
          disabled={busy}
          onPress={() => decline.mutate()}
          style={styles.secondary}
        >
          <Text style={styles.secondaryText}>Decline</Text>
        </Pressable>
      </View>
    </View>
  );
}
