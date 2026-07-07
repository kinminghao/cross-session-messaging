import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

export default defineConfig({
  plugins: [solid()],
  root: __dirname,
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:7351",
      "/ws": { target: "ws://localhost:7351", ws: true },
      "/stats": "http://localhost:7351",
    },
  },
})
