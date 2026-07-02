import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // 개발 중: 브라우저 → vite dev server → 로컬 express(8787) → 기상청
      // authKey는 로컬 express(server/.env)에만 있으므로 이 파일에는 키가 없다.
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
