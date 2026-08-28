import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const root = import.meta.dirname;

export default defineConfig({
  root,
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      "@": path.resolve(root, ".."),
    },
  },
  build: {
    target: "es2022",
    rollupOptions: {
      input: path.resolve(root, "run-report.html"),
    },
    outDir: path.resolve(root, "dist"),
    emptyOutDir: true,
  },
});
