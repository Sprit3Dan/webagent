import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const backendTarget = process.env.VITE_BACKEND_URL || "http://localhost:8000";

const serviceWorkerDevPlugin = () => ({
  name: "service-worker-dev-serve",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url !== "/sw.js") return next();

      const filePath = path.resolve(process.cwd(), "public", "sw.js");
      if (!fs.existsSync(filePath)) return next();

      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.statusCode = 200;
      res.end(fs.readFileSync(filePath, "utf-8"));
    });
  },
});

export default defineConfig({
  envDir: "..",
  plugins: [react(), serviceWorkerDevPlugin()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api/a2a/ws": {
        target: backendTarget,
        changeOrigin: true,
        ws: true,
      },
      "/api": {
        target: backendTarget,
        changeOrigin: true,
      },
      "/docs": {
        target: backendTarget,
        changeOrigin: true,
      },
      "/redoc": {
        target: backendTarget,
        changeOrigin: true,
      },
    },
  },
});