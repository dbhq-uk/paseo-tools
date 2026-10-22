import { useRpc } from "@getpaseo/plugin/client";
import { useInfiniteQuery } from "@tanstack/react-query";
import React, { useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, ScrollView, Text, View } from "react-native";
import { getRows, type SheetMeta } from "../shared/contracts.js";
import type { Styles } from "./theme.js";

const PAGE_SIZE = 200;

interface Props {
  workspaceId: string;
  relPath: string;
  sheets: SheetMeta[];
  styles: Styles;
}

export function SheetReader({ workspaceId, relPath, sheets, styles }: Props) {
  const [active, setActive] = useState(sheets[0]?.name ?? "");
  const fetchRows = useRpc(getRows);

  // Each screenful is its own request, appended to the rows already shown. Changing
  // one query key as the limit grew threw the list away and sent the reader back to
  // the top every time they reached the bottom.
  const { data, isLoading, error, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery({
    queryKey: ["rows", workspaceId, relPath, active],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      fetchRows({ workspaceId, relPath, sheet: active, offset: pageParam, limit: PAGE_SIZE }),
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, part) => n + part.rows.length, 0);
      return last.rows.length > 0 && loaded < last.total ? loaded : undefined;
    },
    enabled: Boolean(active),
  });

  if (sheets.length === 0) {
    return (
      <View style={styles.centre}>
        <Text style={styles.muted}>This workbook has no sheets</Text>
      </View>
    );
  }

  const rows = useMemo(() => data?.pages.flatMap((part) => part.rows) ?? [], [data]);
  const total = data?.pages[0]?.total ?? 0;

  return (
    <View style={styles.screen}>
      {/* Sheet picker. This is the whole reason spreadsheets are parsed rather
          than rasterised - the Azure inventory workbook has 33 named sheets
          that become 169 anonymous pages once it is converted to PDF. */}
      <ScrollView horizontal style={styles.bar} contentContainerStyle={{ gap: 8, alignItems: "center" }}>
        {sheets.map((sheet) => (
          <Pressable
            key={sheet.name}
            onPress={() => {
              setActive(sheet.name);
            }}
            style={sheet.name === active ? styles.buttonOn : styles.button}
            accessibilityRole="button"
            accessibilityLabel={`Sheet ${sheet.name}, ${sheet.rowCount} rows`}
          >
            <Text style={sheet.name === active ? styles.buttonTextOn : styles.buttonText}>{sheet.name}</Text>
          </Pressable>
        ))}
      </ScrollView>

      {isLoading ? (
        <View style={styles.centre}>
          <ActivityIndicator />
        </View>
      ) : error ? (
        <Text style={styles.danger}>{(error as Error).message}</Text>
      ) : (
        <ScrollView horizontal>
          <FlatList
            data={rows}
            keyExtractor={(_, i) => String(i)}
            onEndReached={() => {
              if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
            }}
            onEndReachedThreshold={0.6}
            ListFooterComponent={
              rows.length < total ? (
                <Text style={[styles.muted, { padding: styles.pad }]}>
                  Showing {rows.length} of {total} rows
                </Text>
              ) : null
            }
            renderItem={({ item, index }) => (
              <View style={{ flexDirection: "row", backgroundColor: index === 0 ? undefined : undefined }}>
                {item.map((cell, c) => (
                  <View key={c} style={styles.cell}>
                    <Text style={index === 0 ? styles.heading : styles.body} numberOfLines={3}>
                      {cell}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          />
        </ScrollView>
      )}
    </View>
  );
}
