const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE"];
const HTTP_CALL = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\s+(\/[A-Za-z0-9_/{}.\-:]*)/i;

export function stripQuery(path = "") {
  return String(path).split("?")[0].replace(/\/+$/, "") || "/";
}

export function normalizeSlashes(path = "") {
  const withSlash = path.startsWith("/") ? path : `/${path}`;
  return withSlash.replace(/\/{2,}/g, "/");
}

export function templateToRegex(template) {
  const escaped = stripQuery(template).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\\\{[^}]+\\\}/g, "[^/]+")}$`);
}

export function pathKey(method, path) {
  return `${String(method).toUpperCase()} ${stripQuery(path)}`;
}

export function extractHttpCall(text) {
  const match = String(text ?? "").match(HTTP_CALL);
  if (!match) return null;
  return { method: match[1].toUpperCase(), path: stripQuery(match[2]) };
}

export function replaceConcreteSegments(path) {
  return stripQuery(path)
    .replace(/\/(\d+)(?=\/|$)/g, "/{id}")
    .replace(/\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?=\/|$)/g, "/{id}")
    .replace(/\/:[A-Za-z_][\w]*(?=\/|$)/g, (segment) => `/{${segment.slice(2)}}`)
    .replace(/\/\{\{([^}]+)\}\}(?=\/|$)/g, "/{$1}");
}

export function matchSwaggerPath(concretePath, swaggerPaths = []) {
  const path = stripQuery(concretePath);
  for (const template of swaggerPaths) {
    if (template === path || templateToRegex(template).test(path)) {
      return template;
    }
  }
  return replaceConcreteSegments(path);
}

export function slugify(value) {
  return String(value)
    .replace(/^\//, "")
    .replace(/\{([^}]+)\}/g, "$1")
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

export function inferPathResource(path) {
  const parts = slugify(path).split("_").filter(Boolean);
  return parts[0] || "resource";
}

export function inferSingularResource(path) {
  let resource = inferPathResource(path);
  if (resource.endsWith("s") && resource.length > 1) {
    resource = resource.slice(0, -1);
  }
  return resource;
}

export function inferAction(method, path) {
  const resource = inferSingularResource(path);
  const hasPathParam = /\{[^}]+\}/.test(path);
  const actions = {
    GET: hasPathParam ? `retrieve_${resource}` : `list_${resource}`,
    POST: `create_${resource}`,
    PUT: `update_${resource}`,
    PATCH: `patch_${resource}`,
    DELETE: `delete_${resource}`,
  };
  return actions[String(method).toUpperCase()] ?? "call_api";
}

export function isHttpMethod(value) {
  return HTTP_METHODS.includes(String(value).toUpperCase());
}

export function decodeHtml(value = "") {
  return String(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
