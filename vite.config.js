import fs from "fs";
import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/indoor-mapping-3D", // viktigt så att den fungerar från vilken katalog som helst
  build: {
    outDir: "dist",
  },
  server: {
    https: {
      key: fs.readFileSync(path.resolve(__dirname, "cert/key.pem")),
      cert: fs.readFileSync(path.resolve(__dirname, "cert/cert.pem")),
    },
    host: "0.0.0.0",
    port: 5173,
  },
});
