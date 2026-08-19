import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { isHttpMethod, normalizeSlashes, replaceConcreteSegments, stripQuery } from "../utils/http-path.js";
import { PROJECT_ROOT } from "../utils/paths.js";

function walkItems(items = [], trail = []) {
  const requests = [];

  for (const item of items) {
    const folder = [...trail, item.name].filter(Boolean);
    if (Array.isArray(item.item)) {
      requests.push(...walkItems(item.item, folder));
      continue;
    }
    if (item.request) {
      requests.push({ item, folder });
    }
  }

  return requests;
}

function headerMap(headers = []) {
  if (Array.isArray(headers)) {
    return Object.fromEntries(
      headers
        .filter((header) => header && !header.disabled && header.key)
        .map((header) => [header.key, header.value ?? ""]),
    );
  }
  if (headers && typeof headers === "object") return { ...headers };
  return {};
}

function parseBody(body) {
  if (!body || body.mode === "none") return null;
  if (body.mode === "raw") {
    const raw = body.raw ?? "";
    try {
      return JSON.parse(raw);
    } catch {
      return raw || null;
    }
  }
  if (body.mode === "urlencoded") {
    return Object.fromEntries((body.urlencoded ?? []).map((entry) => [entry.key, entry.value]));
  }
  if (body.mode === "formdata") {
    return Object.fromEntries((body.formdata ?? []).map((entry) => [entry.key, entry.value]));
  }
  return body.raw ?? null;
}

function pathFromUrl(url) {
  if (!url) return "/";
  if (typeof url === "string") {
    try {
      const parsed = new URL(url.replace(/\{\{[^}]+\}\}/g, "placeholder"));
      return parsed.pathname;
    } catch {
      const withoutProtocol = url.replace(/^https?:\/\/[^/]+/i, "");
      const path = withoutProtocol.replace(/\{\{[^}]+\}\}/g, "").replace(/^[^/]*/, "");
      return stripQuery(path || "/");
    }
  }

  if (Array.isArray(url.path) && url.path.length > 0) {
    return normalizeSlashes(url.path.map((part) => String(part).replace(/^:/, "")).join("/"));
  }

  if (url.raw) return pathFromUrl(url.raw);
  return "/";
}

function queryFromUrl(url) {
  if (!url || typeof url === "string") {
    const query = String(url ?? "").split("?")[1];
    if (!query) return {};
    return Object.fromEntries(new URLSearchParams(query));
  }
  if (Array.isArray(url.query)) {
    return Object.fromEntries(
      url.query.filter((entry) => entry.key).map((entry) => [entry.key, entry.value ?? ""]),
    );
  }
  return {};
}

function variableMap(variables = []) {
  if (Array.isArray(variables)) {
    return Object.fromEntries(
      variables.filter((item) => item?.key).map((item) => [item.key, item.value ?? ""]),
    );
  }
  if (variables && typeof variables === "object") return { ...variables };
  return {};
}

export async function readPostmanCollection(source) {
  if (!source) {
    throw new Error("Informe o caminho da collection Postman (JSON).");
  }

  const absolutePath = resolve(PROJECT_ROOT, source);
  const fileInfo = await stat(absolutePath);
  if (!fileInfo.isFile()) {
    throw new Error(`A origem não é um arquivo: ${absolutePath}`);
  }

  let document;
  try {
    document = JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    throw new Error(`JSON inválido: ${error.message}`, { cause: error });
  }

  const items = document.item ?? document.items ?? [];
  const walked = walkItems(items);
  if (walked.length === 0) {
    throw new Error("Nenhum request encontrado na collection.");
  }

  const requests = walked.map(({ item, folder }) => {
    const request = item.request ?? {};
    const method = String(request.method ?? "GET").toUpperCase();
    if (!isHttpMethod(method) && request.method) {
      return null;
    }
    const rawPath = pathFromUrl(request.url);
    const path = replaceConcreteSegments(stripQuery(rawPath));

    return {
      name: item.name ?? `${method} ${path}`,
      folder,
      method,
      path,
      rawPath: stripQuery(rawPath),
      url: typeof request.url === "string" ? request.url : request.url?.raw ?? "",
      headers: headerMap(request.header),
      query: queryFromUrl(request.url),
      body: parseBody(request.body),
    };
  }).filter(Boolean);

  const byEndpoint = {};
  for (const request of requests) {
    const key = `${request.method} ${request.path}`;
    if (!byEndpoint[key]) byEndpoint[key] = request;
  }

  return {
    source: absolutePath,
    name: document.info?.name ?? null,
    variables: variableMap(document.variable),
    requests,
    byEndpoint,
  };
}
