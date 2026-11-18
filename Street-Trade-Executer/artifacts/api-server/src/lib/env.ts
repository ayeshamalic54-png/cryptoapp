import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

function loadLocalEnvFallback(): void {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(process.cwd(), ".env"),
      path.resolve(process.cwd(), "../.env"),
      path.resolve(process.cwd(), "../../.env"),
      path.resolve(process.cwd(), "../../../.env"),
      path.resolve(dir, "../.env"),
      path.resolve(dir, "../../.env"),
      path.resolve(dir, "../../../.env"),
      path.resolve(dir, "../../../../.env"),
    ];
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      const lines = fs.readFileSync(candidate, "utf8").split(/\r?\n/);
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const eqIdx = line.indexOf("=");
        if (eqIdx <= 0) continue;
        const key = line.slice(0, eqIdx).trim();
        let val = line.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        // Only runs locally where .env exists (.env is gitignored on Render).
        // Overrides stale OS-level environment variables cleanly just like dotenv(override=True).
        process.env[key] = val;
      }
      break;
    }
  } catch {
    // Non-fatal on cloud deployments where env vars are injected natively
  }
}

loadLocalEnvFallback();
