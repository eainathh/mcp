import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const MAX_SWAGGER_SIZE = 10 * 1024 * 1024;
const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
  "trace",
]);

function resolveReference(document, value) {
  if (!value?.$ref?.startsWith("#/")) return value;

  return value.$ref
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((current, part) => current?.[part], document);
}

function validateSwagger(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("O conteúdo JSON não é um objeto Swagger válido.");
  }
  if (typeof document.swagger !== "string" && typeof document.openapi !== "string") {
    throw new Error('O documento não possui os campos "swagger" ou "openapi".');
  }
  if (!document.paths || typeof document.paths !== "object") {
    throw new Error('O documento não possui o objeto obrigatório "paths".');
  }
}

function inferType(schema) {
  if (!schema) return "unknown";
  if (schema.type) return schema.type;
  if (schema.properties) return "object";
  if (schema.items) return "array";
  if (Array.isArray(schema.enum)) return "enum";
  return "unknown";
}

function extractValidation(schema) {
  if (!schema) return {};

  const validation = {};

  if (schema.format) validation.format = schema.format;
  if (schema.pattern) validation.pattern = schema.pattern;
  if (schema.enum) validation.enum = schema.enum;
  if (schema.minLength !== undefined) validation.minLength = schema.minLength;
  if (schema.maxLength !== undefined) validation.maxLength = schema.maxLength;
  if (schema.minimum !== undefined) validation.minimum = schema.minimum;
  if (schema.maximum !== undefined) validation.maximum = schema.maximum;
  if (schema.exclusiveMinimum !== undefined) {
    validation.exclusiveMinimum = schema.exclusiveMinimum;
  }
  if (schema.exclusiveMaximum !== undefined) {
    validation.exclusiveMaximum = schema.exclusiveMaximum;
  }
  if (schema.minItems !== undefined) validation.minItems = schema.minItems;
  if (schema.maxItems !== undefined) validation.maxItems = schema.maxItems;
  if (schema.uniqueItems !== undefined) validation.uniqueItems = schema.uniqueItems;
  if (schema.nullable !== undefined) validation.nullable = schema.nullable;
  if (schema.required) validation.requiredFields = schema.required;

  return validation;
}

function parameterToEntry(document, parameter, overrides = {}) {
  const resolved = resolveReference(document, parameter);
  if (!resolved?.name) return null;

  const schema = resolveReference(document, resolved.schema ?? resolved);
  const required =
    overrides.required ?? (resolved.in === "path" || resolved.required === true);

  return {
    name: resolved.name,
    required: Boolean(required),
    type: inferType(schema),
    validation: extractValidation(schema),
  };
}

function extractBodyParams(document, operation) {
  const params = [];

  if (operation.requestBody) {
    const requestBody = resolveReference(document, operation.requestBody);
    const mediaTypes = requestBody?.content ?? {};

    for (const [contentType, media] of Object.entries(mediaTypes)) {
      const schema = resolveReference(document, media?.schema);
      if (!schema) continue;

      if (schema.properties) {
        const requiredFields = new Set(schema.required ?? []);
        for (const [name, propertySchema] of Object.entries(schema.properties)) {
          const schemaResolved = resolveReference(document, propertySchema);
          params.push({
            name,
            required: requiredFields.has(name) || requestBody.required === true,
            type: inferType(schemaResolved),
            validation: {
              contentType,
              ...extractValidation(schemaResolved),
            },
          });
        }
      } else {
        params.push({
          name: "body",
          required: requestBody.required ?? false,
          type: inferType(schema),
          validation: {
            contentType,
            ...extractValidation(schema),
          },
        });
      }
    }

    return params;
  }

  for (const parameter of operation.parameters ?? []) {
    const resolved = resolveReference(document, parameter);
    if (resolved?.in !== "body") continue;

    const schema = resolveReference(document, resolved.schema ?? resolved);
    if (schema?.properties) {
      const requiredFields = new Set(schema.required ?? []);
      for (const [name, propertySchema] of Object.entries(schema.properties)) {
        const schemaResolved = resolveReference(document, propertySchema);
        params.push({
          name,
          required: requiredFields.has(name) || resolved.required === true,
          type: inferType(schemaResolved),
          validation: extractValidation(schemaResolved),
        });
      }
    } else {
      params.push({
        name: resolved.name ?? "body",
        required: resolved.required ?? false,
        type: inferType(schema),
        validation: extractValidation(schema),
      });
    }
  }

  return params;
}

function resolveSecurityScheme(document, schemeName) {
  const schemes = document.components?.securitySchemes ?? document.securityDefinitions ?? {};
  const scheme = resolveReference(document, schemes[schemeName]);
  if (!scheme) {
    return { name: schemeName, type: "unknown" };
  }

  return {
    name: schemeName,
    type: scheme.type ?? "unknown",
    in: scheme.in ?? null,
    scheme: scheme.scheme ?? null,
    bearerFormat: scheme.bearerFormat ?? null,
    flows: scheme.flows ?? null,
  };
}

function extractAuth(document, operation) {
  const security = operation.security ?? document.security ?? [];
  const isExplicitlyPublic = operation.security?.length === 0;
  const requiresAuth = !isExplicitlyPublic && Array.isArray(security) && security.length > 0;

  const schemeNames = requiresAuth
    ? [...new Set(security.flatMap((entry) => Object.keys(entry)))]
    : [];

  return {
    required: requiresAuth,
    schemes: schemeNames.map((name) => resolveSecurityScheme(document, name)),
  };
}

function extractResponses(document, operation) {
  return Object.entries(operation.responses ?? {}).map(([status, responseValue]) => {
    const response = resolveReference(document, responseValue);
    const content = response?.content ?? {};
    const contentTypes = Object.keys(content);
    const primaryContent = contentTypes[0];
    const schema = primaryContent
      ? resolveReference(document, content[primaryContent]?.schema)
      : resolveReference(document, response?.schema);

    return {
      status,
      description: response?.description ?? null,
      contentType: primaryContent ?? null,
      type: inferType(schema),
    };
  });
}

function parseDocument(document) {
  const endpoints = [];

  for (const [path, pathItem] of Object.entries(document.paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;

    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase()) || !operation) continue;

      const parameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]
        .map((parameter) => resolveReference(document, parameter))
        .filter((parameter) => parameter && parameter.in !== "body");

      const params = [
        ...parameters
          .map((parameter) => parameterToEntry(document, parameter))
          .filter(Boolean),
        ...extractBodyParams(document, operation),
      ];

      endpoints.push({
        method: method.toUpperCase(),
        path,
        params,
        auth: extractAuth(document, operation),
        responses: extractResponses(document, operation),
      });
    }
  }

  if (endpoints.length === 0) {
    throw new Error("Nenhum endpoint HTTP foi encontrado no documento.");
  }

  return endpoints;
}

export async function parseSwagger(filePath) {
  const absolutePath = resolve(filePath);
  const fileInfo = await stat(absolutePath);

  if (!fileInfo.isFile()) {
    throw new Error(`A origem não é um arquivo: ${absolutePath}`);
  }
  if (fileInfo.size > MAX_SWAGGER_SIZE) {
    throw new Error("O arquivo excede o limite de 10 MB.");
  }

  let document;
  try {
    document = JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`JSON inválido: ${error.message}`, { cause: error });
    }
    throw error;
  }

  validateSwagger(document);
  return parseDocument(document);
}
