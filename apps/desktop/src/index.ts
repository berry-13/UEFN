import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Directory holding the dashboard (index.html, styles.css and the compiled js/), for `DevToolsDaemon({ staticDir })`. */
export function desktopStaticDir(): string {
  return fileURLToPath(new URL("../public", import.meta.url));
}

/** True when the UI has been built (`pnpm build` compiles ui/ into public/js). */
export function desktopUiBuilt(): boolean {
  return existsSync(fileURLToPath(new URL("../public/js/main.js", import.meta.url)));
}
