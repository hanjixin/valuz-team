import path from "node:path";
import { defineConfig } from "vite";
import { editionOverlayPlugin } from "@valuz/core/vite";
import { baseViteConfig } from "@valuz/shared/vite";

const base = baseViteConfig({
  configDir: __dirname,
  editionOverlay: editionOverlayPlugin(),
});

export default defineConfig({
  ...base,
  envDir: path.resolve(__dirname, "../.."),
  define: {
    ...base.define,
    ...(process.env.NODE_ENV === "production" ||
    !process.env.VITE_DEV_SERVER_URL
      ? {
          "import.meta.env.VITE_API_BASE_URL": JSON.stringify(
            "http://localhost:19100",
          ),
        }
      : {}),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    open: false,
  },
  base: "./",
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        update: path.resolve(__dirname, "update.html"),
      },
    },
  },
});
