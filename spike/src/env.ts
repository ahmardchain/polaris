import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

loadEnv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env"),
});
