import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev the API runs separately; in production the server serves this build itself.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // `@valuz/ui` reads the build edition; this app always ships the base one.
  define: { __EDITION__: JSON.stringify("personal") },
  resolve: { dedupe: ["react", "react-dom"] },
  server: {
    port: 5273,
    proxy: { "/v1": { target: process.env["API_URL"] ?? "http://127.0.0.1:8787", changeOrigin: true }, "/health": "http://127.0.0.1:8787" },
  },
});
