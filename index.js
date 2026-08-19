#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import axios from "axios";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

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

let lastSwagger = null;
let lastSource = null;

const server = new McpServer({
  name: "swagger-scenario-generator",
  version: "1.0.0",
});

async function loadSwagger(source) {
  let rawContent;

  if (/^https?:\/\//i.test(source)) {
    const response = await axios.get(source, {
      responseType: "text",
      timeout: 15_000,
      maxContentLength: MAX_SWAGGER_SIZE,
      transformResponse: [(data) => data],
    });
    rawContent = response.data;
  } else {
    const absolutePath = resolve(source);
    const fileInfo = await stat(absolutePath);

    if (!fileInfo.isFile()) {
      throw new Error(`A origem não é um arquivo: ${absolutePath}`);
    }
    if (fileInfo.size > MAX_SWAGGER_SIZE) {
      throw new Error("O arquivo excede o limite de 10 MB.");
    }

    rawContent = await readFile(absolutePath, "utf8");
  }

  if (typeof rawContent !== "string") {
    rawContent = JSON.stringify(rawContent);
  }
  if (Buffer.byteLength(rawContent, "utf8") > MAX_SWAGGER_SIZE) {
    throw new Error("O arquivo excede o limite de 10 MB.");
  }

  let document;
  try {
    document = JSON.parse(rawContent);
  } catch (error) {
    throw new Error(`JSON inválido: ${error.message}`, { cause: error });
  }

  validateSwagger(document);
  return document;
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

function errorResult(context, error) {
  let message = error instanceof Error ? error.message : String(error);

  if (axios.isAxiosError(error)) {
    message = error.response
      ? `HTTP ${error.response.status} ao acessar a URL`
      : error.code === "ECONNABORTED"
        ? "Tempo limite de 15 segundos excedido"
        : `Falha HTTP: ${error.message}`;
  }

  return {
    isError: true,
    content: [{ type: "text", text: `${context}: ${message}` }],
  };
}

function resolveReference(document, value) {
  if (!value?.$ref?.startsWith("#/")) return value;

  return value.$ref
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((current, part) => current?.[part], document);
}

function sampleFromSchema(document, originalSchema, depth = 0) {
  const schema = resolveReference(document, originalSchema);
  if (!schema || depth > 6) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];

  if (schema.type === "object" || schema.properties) {
    return Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([name, property]) => [
        name,
        sampleFromSchema(document, property, depth + 1),
      ]),
    );
  }
  if (schema.type === "array") {
    return [sampleFromSchema(document, schema.items, depth + 1)];
  }

  return {
    string: schema.format === "email" ? "usuario@exemplo.com" : "exemplo",
    integer: 1,
    number: 1.5,
    boolean: true,
  }[schema.type] ?? "exemplo";
}

function getRequestBody(document, operation) {
  if (operation.requestBody) {
    const requestBody = resolveReference(document, operation.requestBody);
    const media = requestBody?.content?.["application/json"]
      ?? Object.values(requestBody?.content ?? {})[0];
    return sampleFromSchema(document, media?.schema);
  }

  const bodyParameter = (operation.parameters ?? [])
    .map((parameter) => resolveReference(document, parameter))
    .find((parameter) => parameter?.in === "body");
  return bodyParameter ? sampleFromSchema(document, bodyParameter.schema) : null;
}

function invalidValue(value) {
  if (typeof value === "string") return 12345;
  if (typeof value === "number") return "valor-invalido";
  if (typeof value === "boolean") return "valor-invalido";
  if (Array.isArray(value)) return {};
  if (value && typeof value === "object") return [];
  return "valor-invalido";
}

function makeInvalidRequest(request) {
  const invalid = structuredClone(request);

  if (invalid.body && typeof invalid.body === "object" && !Array.isArray(invalid.body)) {
    const firstField = Object.keys(invalid.body)[0];
    if (firstField) {
      invalid.body[firstField] = invalidValue(invalid.body[firstField]);
      return invalid;
    }
  }

  const parameterGroup = Object.keys(invalid.queryParams).length
    ? invalid.queryParams
    : invalid.pathParams;
  const firstParameter = Object.keys(parameterGroup)[0];
  if (firstParameter) parameterGroup[firstParameter] = "valor-invalido";

  return invalid;
}

function generateScenarios(document) {
  const scenarios = [];

  for (const [path, pathItem] of Object.entries(document.paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;

    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method.toLowerCase()) || !operation) continue;

      const parameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]
        .map((parameter) => resolveReference(document, parameter))
        .filter(Boolean);
      const request = {
        method: method.toUpperCase(),
        path,
        headers: {},
        pathParams: {},
        queryParams: {},
        body: getRequestBody(document, operation),
      };

      for (const parameter of parameters) {
        const value = sampleFromSchema(document, parameter.schema ?? parameter);
        if (parameter.in === "path") request.pathParams[parameter.name] = value;
        if (parameter.in === "query") request.queryParams[parameter.name] = value;
        if (parameter.in === "header") request.headers[parameter.name] = String(value);
      }

      const security = operation.security ?? document.security ?? [];
      const requiresAuth = Array.isArray(security) && security.length > 0;
      const authSchemes = requiresAuth ? Object.keys(security[0] ?? {}) : [];
      if (requiresAuth) request.headers.Authorization = "Bearer <token-valido>";

      const responseCodes = Object.keys(operation.responses ?? {});
      const successCodes = responseCodes.filter((code) => /^2\d\d$/.test(code));
      const baseId = operation.operationId ?? `${method}-${path}`
        .replace(/[^\w]+/g, "-")
        .replace(/^-|-$/g, "");
      const common = {
        endpoint: { method: method.toUpperCase(), path },
        operationId: operation.operationId ?? null,
      };

      scenarios.push(
        {
          id: `${baseId}-happy-path`,
          type: "happy_path",
          name: `Sucesso em ${method.toUpperCase()} ${path}`,
          description: "Envia dados válidos e autenticação quando necessária.",
          ...common,
          request,
          expected: {
            statusCodes: successCodes.length ? successCodes : ["200", "201", "204"],
            outcome: "A operação deve ser concluída com sucesso.",
          },
        },
        {
          id: `${baseId}-sad-path`,
          type: "sad_path",
          name: `Falha esperada em ${method.toUpperCase()} ${path}`,
          description: "Usa um recurso inexistente ou omite um dado obrigatório.",
          ...common,
          request: {
            ...structuredClone(request),
            pathParams: Object.fromEntries(
              Object.keys(request.pathParams).map((name) => [name, "inexistente"]),
            ),
          },
          expected: {
            statusCodes: ["400", "404", "409", "422"],
            outcome: "A API deve rejeitar a requisição com erro de negócio ou validação.",
          },
        },
        {
          id: `${baseId}-invalid-data`,
          type: "invalid_data",
          name: `Dados inválidos em ${method.toUpperCase()} ${path}`,
          description: "Troca o tipo de um campo ou parâmetro por um valor incompatível.",
          ...common,
          request: makeInvalidRequest(request),
          expected: {
            statusCodes: ["400", "422"],
            outcome: "A API deve informar que os dados enviados são inválidos.",
          },
        },
        {
          id: `${baseId}-without-auth`,
          type: "without_auth",
          name: `Sem autenticação em ${method.toUpperCase()} ${path}`,
          description: requiresAuth
            ? `Remove a autenticação exigida (${authSchemes.join(", ") || "esquema global"}).`
            : "Confirma que o endpoint público funciona sem autenticação.",
          ...common,
          request: {
            ...structuredClone(request),
            headers: Object.fromEntries(
              Object.entries(request.headers).filter(
                ([name]) => name.toLowerCase() !== "authorization",
              ),
            ),
          },
          expected: {
            statusCodes: requiresAuth ? ["401", "403"] : (successCodes.length ? successCodes : ["200"]),
            outcome: requiresAuth
              ? "A API deve negar o acesso."
              : "A API deve permitir o acesso ao endpoint público.",
          },
        },
      );
    }
  }

  if (scenarios.length === 0) {
    throw new Error("Nenhum endpoint HTTP foi encontrado no documento.");
  }

  return {
    swagger: {
      title: document.info?.title ?? null,
      version: document.info?.version ?? null,
      specification: document.openapi ?? document.swagger,
    },
    summary: {
      endpoints: scenarios.length / 4,
      scenarios: scenarios.length,
      types: ["happy_path", "sad_path", "invalid_data", "without_auth"],
    },
    scenarios,
  };
}

server.registerTool(
  "read_swagger",
  {
    title: "Ler Swagger",
    description: "Lê e valida um Swagger/OpenAPI JSON local ou disponível por HTTP(S).",
    inputSchema: {
      source: z.string().min(1).describe("Caminho do arquivo JSON ou URL HTTP(S)"),
    },
    outputSchema: {
      source: z.string(),
      specification: z.string(),
      document: z.record(z.string(), z.unknown()),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ source }) => {
    try {
      const document = await loadSwagger(source);
      lastSwagger = document;
      lastSource = source;

      const result = {
        source,
        specification: document.openapi ?? document.swagger,
        document,
      };
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return errorResult("Não foi possível ler o Swagger", error);
    }
  },
);

server.registerTool(
  "generate_scenarios",
  {
    title: "Gerar cenários de teste",
    description:
      "Analisa os endpoints do Swagger e gera happy path, sad path, dados inválidos e teste sem autenticação.",
    inputSchema: {
      source: z
        .string()
        .min(1)
        .optional()
        .describe("Arquivo ou URL. Se omitido, usa o último Swagger lido."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ source }) => {
    try {
      const document = source ? await loadSwagger(source) : lastSwagger;
      if (!document) {
        throw new Error(
          'Informe "source" ou execute a ferramenta "read_swagger" primeiro.',
        );
      }

      if (source) {
        lastSwagger = document;
        lastSource = source;
      }

      const result = {
        source: source ?? lastSource,
        ...generateScenarios(document),
      };
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return errorResult("Não foi possível gerar os cenários", error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
