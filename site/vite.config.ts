import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Project page at https://beamhop.github.io/beambox/ — every asset URL needs the repo prefix.
export default defineConfig({
  base: "/beambox/",
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        // three + shiki dominate the bundle; splitting them keeps the first paint cheap.
        manualChunks: {
          three: ["three", "@react-three/fiber", "@react-three/drei"],
          shiki: ["shiki/core", "shiki/engine/oniguruma"],
        },
      },
    },
  },
})
