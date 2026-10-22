import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import React, { useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Image, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { getPage, ZOOM } from "../shared/contracts.js";
import type { Styles } from "./theme.js";

interface Props {
  workspaceId: string;
  relPath: string;
  pages: number;
  dpi: number;
  styles: Styles;
}

/** One page. Kept separate so each fetches only when it scrolls into view. */
function Page({ workspaceId, relPath, page, dpi, styles, maxWidth }: Props & { page: number; maxWidth: number }) {
  const fetchPage = useRpc(getPage);
  const { data, isLoading, error } = useQuery({
    queryKey: ["page", workspaceId, relPath, page, dpi],
    queryFn: () => fetchPage({ workspaceId, relPath, page, dpi }),
    // A page is a megabyte or more of base64. Drop it soon after it scrolls away.
    gcTime: 60_000,
  });

  if (isLoading) {
    return (
      <View style={[styles.centre, { height: 320 }]}>
        <ActivityIndicator />
        <Text style={styles.muted}>Page {page}</Text>
      </View>
    );
  }
  if (error) return <Text style={styles.danger}>Page {page}: {(error as Error).message}</Text>;
  if (!data) return null;

  // Scale to fit the viewport width, but never blow a small page up beyond
  // its rendered size - that only makes it blurry.
  const ratio = data.height && data.width ? data.height / data.width : 1.414;
  const width = Math.min(data.width || maxWidth, maxWidth);

  return (
    <View style={{ marginBottom: 12 }}>
      <Image
        source={{ uri: data.dataUri }}
        style={{ width, height: width * ratio }}
        resizeMode="contain"
        accessibilityLabel={`Page ${page}`}
      />
    </View>
  );
}

export function PageReader({ workspaceId, relPath, pages, styles }: Omit<Props, "dpi">) {
  const [zoom, setZoom] = useState(0);
  const { width: windowWidth } = useWindowDimensions();
  const dpi = ZOOM[zoom].dpi;

  // At anything above Fit the page is wider than the viewport on purpose, so
  // the reader scrolls sideways. This replaces pinch-zoom, which React Native
  // only supports on iOS and which needs a gesture library we cannot import.
  const contentWidth = Math.round(windowWidth * (dpi / ZOOM[0].dpi));
  const pageNumbers = useMemo(() => Array.from({ length: pages }, (_, i) => i + 1), [pages]);

  return (
    <View style={styles.screen}>
      <View style={styles.bar}>
        <Text style={styles.muted}>{pages} {pages === 1 ? "page" : "pages"}</Text>
        <View style={{ flex: 1 }} />
        {ZOOM.map((level, index) => (
          <Text
            key={level.label}
            onPress={() => setZoom(index)}
            accessibilityRole="button"
            accessibilityLabel={`Zoom ${level.label}`}
            style={[index === zoom ? styles.buttonOn : styles.button, index === zoom ? styles.buttonTextOn : styles.buttonText]}
          >
            {level.label}
          </Text>
        ))}
      </View>
      <ScrollView horizontal={contentWidth > windowWidth}>
        {/* A list, not a ScrollView of every page: only the pages near the screen are
            mounted, so only those are rendered on the server. A 200-page PDF costs a
            few pages of work at a time. */}
        <FlatList
          style={{ width: contentWidth }}
          contentContainerStyle={{ alignItems: "center", padding: styles.pad }}
          data={pageNumbers}
          keyExtractor={(n) => String(n)}
          initialNumToRender={2}
          maxToRenderPerBatch={2}
          windowSize={5}
          removeClippedSubviews
          renderItem={({ item }) => (
            <Page
              page={item}
              workspaceId={workspaceId}
              relPath={relPath}
              pages={pages}
              dpi={dpi}
              styles={styles}
              maxWidth={contentWidth - styles.pad * 2}
            />
          )}
        />
      </ScrollView>
    </View>
  );
}
