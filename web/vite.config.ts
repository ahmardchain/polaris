import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/polaris/",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/near-rpc": {
        target: "https://rpc.testnet.near.org",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/near-rpc/, ""),
      },
    },
  },
});
