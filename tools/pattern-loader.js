import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { PROJECT_ROOT } from "../utils/paths.js";

const REQUIRED_FIELDS = [
  ["naming", "test_file"],
  ["naming", "test_case"],
  ["structure", "endpoints_dir"],
  ["structure", "keywords_dir"],
  ["structure", "steps_dir"],
];

export const DEFAULT_PATTERNS = {
  naming: {
    test_file: "{method}_{resource}_{action}_{scenario}.robot",
    test_case: "{method} {path} - {azure_test_id}",
    scenario_default: "success",
  },
  structure: {
    output_root: "your-robot-project",
    endpoints_dir: "tests/endpoints",
    keywords_dir: "tests/resources",
    steps_dir: "tests/resources/steps",
    data_dir: "tests/data",
    lib_dir: "lib",
    reports_dir: "reports",
    settings: [
      "Resource    ../resources/common.resource",
      "Resource    ../resources/auth.resource",
    ],
  },
  tags: {
    required: ["regressivo", "api"],
    from_azure: true,
  },
  auth: {
    header: "Authorization",
    env_token: "API_TOKEN",
    scheme: "Bearer",
  },
};

function parseScalar(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value.replace(/^["']|["']$/g, "");
}

function emptyContainer(lines, startIndex, parentIndent) {
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.match(/^ */)[0].length;
    if (indent <= parentIndent) return {};
    return raw.trim().startsWith("- ") ? [] : {};
  }
  return {};
}

export function parseSimpleYaml(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }

  const lines = text.split(/\r?\n/);
  const root = {};
  const stack = [{ indent: -1, value: root }];

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (!raw.trim() || raw.trim().startsWith("#")) continue;

    const indent = raw.match(/^ */)[0].length;
    const line = raw.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const current = stack[stack.length - 1];

    if (line.startsWith("- ")) {
      if (!Array.isArray(current.value)) {
        throw new Error("YAML inválido: item de lista fora de um array.");
      }
      const itemText = line.slice(2).trim();
      if (!itemText) {
        const nested = emptyContainer(lines, index, indent);
        current.value.push(nested);
        stack.push({ indent, value: nested });
        continue;
      }
      if (itemText.includes(":") && !itemText.startsWith("{")) {
        const colon = itemText.indexOf(":");
        const nested = { [itemText.slice(0, colon).trim()]: parseScalar(itemText.slice(colon + 1).trim()) };
        current.value.push(nested);
        stack.push({ indent, value: nested });
        continue;
      }
      current.value.push(parseScalar(itemText));
      continue;
    }

    const colon = line.indexOf(":");
    if (colon === -1) {
      throw new Error(`YAML inválido na linha ${index + 1}: ${line}`);
    }

    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();

    if (!rest) {
      const nested = emptyContainer(lines, index, indent);
      current.value[key] = nested;
      stack.push({ indent, value: nested });
      continue;
    }

    current.value[key] = parseScalar(rest);
  }

  return root;
}

function getPath(object, segments) {
  return segments.reduce((current, segment) => current?.[segment], object);
}

function merge(base, overlay) {
  if (Array.isArray(overlay)) return overlay;
  if (!overlay || typeof overlay !== "object") return overlay ?? base;
  const result = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    result[key] = merge(base?.[key], value);
  }
  return result;
}

function assertPatterns(patterns) {
  for (const path of REQUIRED_FIELDS) {
    if (getPath(patterns, path) === undefined) {
      throw new Error(`Pattern inválido: campo obrigatório ausente (${path.join(".")}).`);
    }
  }
}

export async function loadPatterns(patternsPath) {
  if (!patternsPath) {
    throw new Error("Informe o arquivo de patterns (ex.: patterns/company.yaml).");
  }

  const absolutePath = resolve(PROJECT_ROOT, patternsPath);
  const fileInfo = await stat(absolutePath);
  if (!fileInfo.isFile()) {
    throw new Error(`O arquivo de patterns não existe: ${absolutePath}`);
  }

  const raw = await readFile(absolutePath, "utf8");
  const parsed = extname(absolutePath).toLowerCase() === ".json"
    ? JSON.parse(raw)
    : parseSimpleYaml(raw);
  const patterns = merge(DEFAULT_PATTERNS, parsed);
  assertPatterns(patterns);
  return { path: absolutePath, patterns };
}
