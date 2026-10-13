import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // 刻意避开常用的 5173/5174；strictPort 保证被占用时报错而不是静默漂移
    port: 8517,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
});
