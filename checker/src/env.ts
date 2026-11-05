import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
loadEnv({ path: resolve(root, "spike/.env") });
loadEnv({ path: resolve(root, "checker/.env") });
