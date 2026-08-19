import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { maskRecord } from "../utils/secrets.js";
import { PROJECT_ROOT } from "../utils/paths.js";

export async function loadEnv(envPath = ".env") {
  const absolutePath = resolve(PROJECT_ROOT, envPath);
  const fileInfo = await stat(absolutePath);
  if (!fileInfo.isFile()) {
    throw new Error(`Arquivo .env não encontrado: ${absolutePath}`);
  }

  const parsed = parseDotenv(await readFile(absolutePath, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return {
    path: absolutePath,
    values: parsed,
    masked: maskRecord(parsed),
    keys: Object.keys(parsed),
  };
}

export function envValue(...names) {
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }
  return undefined;
}
