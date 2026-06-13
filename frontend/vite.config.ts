import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "fs";
import { resolve } from "path";

const rootPkg = JSON.parse(
  readFileSync(resolve(__dirname, "../package.json"), "utf-8"),
);

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version),
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": {
        // Use 127.0.0.1 (not "localhost") so Node's dual-stack DNS
        // doesn't try ::1 first and fail with ECONNREFUSED — the
        // backend binds only to 127.0.0.1 by default.
        target: "http://127.0.0.1:4000",
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("error", () => {});
        },
      },
      "/socket.io": {
        target: "http://127.0.0.1:4000",
        ws: true,
        configure: (proxy) => {
          // Swallow proxy errors so a single broken client socket doesn't
          // spam the dev terminal.
          proxy.on("error", () => {});
          // The browser side of a long-lived ws can disappear while
          // llama-server is still grinding on a chunk. When Vite later writes
          // to it we get EPIPE / ECONNRESET — harmless, but noisy.
          proxy.on("proxyReqWs", (_proxyReq, _req, socket) => {
            socket.on("error", () => {});
          });
          proxy.on("open", (socket) => {
            socket.on("error", () => {});
          });
          proxy.on("close", (_res, socket) => {
            socket.on?.("error", () => {});
          });
        },
      },
    },
  },
  build: {
    target: "esnext",
  },
});
