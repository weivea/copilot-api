import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/main.ts"],

  format: ["esm"],
  target: "es2022",
  platform: "node",
  external: [/^bun:/],

  sourcemap: true,
  clean: ["dist/main.js", "dist/main.js.map"],
  removeNodeProtocol: false,

  env: {
    NODE_ENV: "production",
  },
})
