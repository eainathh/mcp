import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MCP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PROJECT_ROOT = resolve(MCP_DIR, "..");

export function resolveFromProject(target = ".") {
  return resolve(PROJECT_ROOT, target);
}
