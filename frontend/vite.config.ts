import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../dist/public",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return "react-vendor"
          }
          if (/[\\/]node_modules[\\/](react-router|react-router-dom|@remix-run)[\\/]/.test(id)) {
            return "router"
          }
          if (/[\\/]node_modules[\\/](recharts|d3-[^/\\]+)[\\/]/.test(id)) {
            return "charts"
          }
          return undefined
        },
      },
    },
  },
  server: {
    proxy: {
      "/admin/api": "http://localhost:4141",
    },
  },
})
