import { defineConfig } from "@apps-in-toss/web-framework/config";

export default defineConfig({
  appName: "movie-tago",
  brand: {
    primaryColor: "#8A4FD1",
  },
  permissions: [{ name: "clipboard", access: "write" }],
  webView: {
    bounces: false,
    pullToRefreshEnabled: false,
    overScrollMode: "never",
  },
  webBundleDir: "dist",
});
