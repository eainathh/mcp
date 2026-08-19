import { extractHttpCall, inferPathResource, matchSwaggerPath, pathKey, stripQuery } from "../utils/http-path.js";

function swaggerPaths(document) {
  return document?.paths ? Object.keys(document.paths) : [];
}

function swaggerOperation(document, method, path) {
  const item = document?.paths?.[path];
  const operation = item?.[method.toLowerCase()] ?? item?.[method.toUpperCase()];
  if (!operation) return { expectedStatus: [], operationId: null, requiresAuth: false };

  const responseCodes = Object.keys(operation.responses ?? {});
  const successCodes = responseCodes.filter((code) => /^2\d\d$/.test(code));
  const security = operation.security ?? document.security ?? [];

  return {
    expectedStatus: successCodes,
    operationId: operation.operationId ?? null,
    requiresAuth: Array.isArray(security) && security.length > 0,
    responses: responseCodes,
  };
}

function statusFromText(text) {
  const matches = String(text ?? "").match(/\b([1-5]\d\d)\b/g);
  return matches ? [...new Set(matches)] : [];
}

function findPostman(postman, method, path, templates) {
  const template = matchSwaggerPath(path, templates);
  const exact = postman?.byEndpoint?.[pathKey(method, template)]
    ?? postman?.byEndpoint?.[pathKey(method, path)];
  if (exact) return exact;

  return (postman?.requests ?? []).find((request) => {
    const requestTemplate = matchSwaggerPath(request.path, templates);
    return request.method === method && (requestTemplate === template || request.path === path);
  }) ?? null;
}

function findSwaggerPath(templates, path) {
  return templates.find((template) => template === path || matchSwaggerPath(path, [template]) === template)
    ?? matchSwaggerPath(path, templates);
}

function hintFromCase(testCase) {
  if (testCase.httpHint) return testCase.httpHint;
  const blob = [testCase.title, ...testCase.steps.map((step) => `${step.action} ${step.expected}`)].join(" ");
  return extractHttpCall(blob);
}

function expectedStatus(testCase, swaggerInfo) {
  const fromSteps = testCase.steps.flatMap((step) => statusFromText(`${step.action} ${step.expected}`));
  if (fromSteps.length) return fromSteps;
  if (swaggerInfo.expectedStatus.length) return swaggerInfo.expectedStatus;
  return ["200"];
}

export function matchScenarios({ testPlan, postman, swagger } = {}) {
  if (!testPlan?.cases?.length) {
    throw new Error("Nenhum caso Azure carregado. Execute read_azure_test_plan primeiro.");
  }
  if (!postman?.requests?.length && !postman?.byEndpoint) {
    throw new Error("Nenhuma collection Postman carregada. Execute read_postman_collection primeiro.");
  }
  if (!swagger?.paths) {
    throw new Error("Nenhum Swagger carregado. Execute read_swagger primeiro.");
  }

  const templates = swaggerPaths(swagger);
  const matched = [];
  const unmatched = [];
  const coveredKeys = new Set();

  for (const testCase of testPlan.cases) {
    const hint = hintFromCase(testCase);
    if (!hint) {
      unmatched.push({
        azureTestId: testCase.id,
        title: testCase.title,
        reason: "Caso narrativo sem método/path explícito (não gerar .robot chutado).",
      });
      continue;
    }

    const swaggerPath = findSwaggerPath(templates, hint.path);
    const swaggerInfo = swaggerOperation(swagger, hint.method, swaggerPath);
    const postmanRequest = findPostman(postman, hint.method, hint.path, templates);

    if (!postmanRequest) {
      unmatched.push({
        azureTestId: testCase.id,
        title: testCase.title,
        method: hint.method,
        path: hint.path,
        reason: "Não há request correspondente na collection Postman.",
      });
      continue;
    }

    const key = pathKey(hint.method, swaggerPath);
    coveredKeys.add(key);

    matched.push({
      azureTestId: testCase.id,
      title: testCase.title,
      tags: testCase.tags ?? [],
      linkedRequirement: testCase.linkedRequirement,
      steps: testCase.steps,
      endpoint: { method: hint.method, path: swaggerPath },
      resource: inferPathResource(swaggerPath),
      postman: {
        name: postmanRequest.name,
        headers: postmanRequest.headers,
        query: postmanRequest.query,
        body: postmanRequest.body,
        rawPath: postmanRequest.rawPath,
      },
      swagger: {
        operationId: swaggerInfo.operationId,
        responses: swaggerInfo.responses,
        requiresAuth: swaggerInfo.requiresAuth,
      },
      expectedStatus: expectedStatus(testCase, swaggerInfo),
    });
  }

  const uncoveredSwagger = templates.flatMap((path) => {
    const item = swagger.paths[path] ?? {};
    return Object.keys(item)
      .filter((method) => ["get", "post", "put", "patch", "delete", "head", "options"].includes(method))
      .map((method) => pathKey(method.toUpperCase(), path))
      .filter((key) => !coveredKeys.has(key));
  });

  return {
    summary: {
      azureCases: testPlan.cases.length,
      matched: matched.length,
      unmatched: unmatched.length,
      uncoveredSwagger: uncoveredSwagger.length,
    },
    matched,
    unmatched,
    uncoveredSwagger,
  };
}

export function resolveConcretePath(match) {
  const template = match.endpoint.path;
  const raw = stripQuery(match.postman?.rawPath ?? template);
  if (!/\{[^}]+\}/.test(raw) && raw !== template) return raw;

  let path = template;
  const values = { ...(match.postman?.query ?? {}) };
  const segments = stripQuery(match.postman?.rawPath ?? "").split("/").filter(Boolean);
  const names = [...template.matchAll(/\{([^}]+)\}/g)].map((item) => item[1]);
  names.forEach((name, index) => {
    const fallback = segments.filter((segment) => !segment.startsWith("{"))[index];
    path = path.replace(`{${name}}`, encodeURIComponent(values[name] ?? fallback ?? "1"));
  });
  return path;
}
