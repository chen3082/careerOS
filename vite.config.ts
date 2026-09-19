import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  base: process.env.BASE_PATH || "/careeros/",
  build: { outDir: "dist/web" },
  server: { proxy: { "/careeros/api": "http://127.0.0.1:3100" } },
});
