import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts", api: "src/api.ts", clients: "src/clients.ts" },
  format: ["esm"],
  target: "node18",
  clean: true,
  splitting: false,
  sourcemap: false,
  dts: false,
  banner: { js: "#!/usr/bin/env node" },
});
