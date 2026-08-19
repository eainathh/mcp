function assertEndpoint(endpoint) {
  if (!endpoint?.method || !endpoint?.path) {
    throw new Error("Endpoint inválido: method e path são obrigatórios.");
  }
  if (!Array.isArray(endpoint.params)) {
    throw new Error("Endpoint inválido: params deve ser um array.");
  }
}

function pathParamNames(path) {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
}

function classifyParams(endpoint) {
  const pathNames = new Set(pathParamNames(endpoint.path));

  return endpoint.params.reduce(
    (groups, param) => {
      if (pathNames.has(param.name)) {
        groups.path.push(param);
      } else if (param.validation?.contentType) {
        groups.body.push(param);
      } else {
        groups.query.push(param);
      }
      return groups;
    },
    { path: [], query: [], body: [] },
  );
}

function validValue(param) {
  const { type, validation = {} } = param;

  if (validation.enum?.length) return validation.enum[0];
  if (validation.format === "email") return "usuario@exemplo.com";
  if (validation.format === "uuid") return "550e8400-e29b-41d4-a716-446655440000";
  if (validation.format === "date") return "2026-01-01";
  if (validation.format === "date-time") return "2026-01-01T00:00:00Z";

  switch (type) {
    case "integer":
      return validation.minimum ?? 1;
    case "number":
      return validation.minimum ?? 1.5;
    case "boolean":
      return true;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return "valor-valido";
  }
}

function invalidValue(param) {
  switch (param.type) {
    case "integer":
    case "number":
      return "tipo-invalido";
    case "boolean":
      return "tipo-invalido";
    case "string":
      return 12345;
    case "array":
      return "tipo-invalido";
    case "object":
      return "tipo-invalido";
    default:
      return null;
  }
}

function buildAuth(endpoint, includeAuth) {
  if (!includeAuth || !endpoint.auth?.required) {
    return null;
  }

  const scheme = endpoint.auth.schemes?.[0];
  if (scheme?.type === "http" && scheme.scheme === "bearer") {
    return { type: "bearer", token: "<token-valido>" };
  }
  if (scheme?.type === "apiKey") {
    return {
      type: "apiKey",
      name: scheme.in === "header" ? "Authorization" : scheme.name,
      value: "<api-key-valida>",
    };
  }

  return { type: scheme?.type ?? "unknown", token: "<credencial-valida>" };
}

function authHeaders(authentication) {
  if (!authentication) return {};

  if (authentication.type === "bearer") {
    return { Authorization: `Bearer ${authentication.token}` };
  }
  if (authentication.type === "apiKey" && authentication.name) {
    return { [authentication.name]: authentication.value };
  }

  return {};
}

function resolvePath(path, values) {
  return path.replace(/\{([^}]+)\}/g, (_, name) =>
    encodeURIComponent(values[name] ?? "valor"),
  );
}

function buildQuery(values) {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return null;
  return Object.fromEntries(entries);
}

function buildBody(bodyParams, values) {
  if (bodyParams.length === 0) return null;

  const contentType = bodyParams[0].validation?.contentType ?? "application/json";
  const body =
    bodyParams.length === 1 && bodyParams[0].name === "body"
      ? values[bodyParams[0].name]
      : Object.fromEntries(bodyParams.map((param) => [param.name, values[param.name]]));

  return { contentType, body };
}

function successStatuses(responses = []) {
  const success = responses
    .map((response) => response.status)
    .filter((status) => /^2\d\d$/.test(status));
  return success.length ? success : ["200", "201", "204"];
}

function buildRequest(endpoint, groups, values, includeAuth) {
  const authentication = buildAuth(endpoint, includeAuth);
  const pathValues = Object.fromEntries(groups.path.map((param) => [param.name, values[param.name]]));
  const queryValues = Object.fromEntries(groups.query.map((param) => [param.name, values[param.name]]));
  const bodyValues = Object.fromEntries(groups.body.map((param) => [param.name, values[param.name]]));

  return {
    method: endpoint.method,
    path: resolvePath(endpoint.path, pathValues),
    headers: authHeaders(authentication),
    query: buildQuery(queryValues),
    body: buildBody(groups.body, bodyValues),
  };
}

function validParamValues(params) {
  return Object.fromEntries(params.map((param) => [param.name, validValue(param)]));
}

function pickRequiredParam(groups) {
  return [...groups.path, ...groups.query, ...groups.body].find((param) => param.required);
}

function pickInvalidTarget(groups) {
  const candidates = [...groups.path, ...groups.query, ...groups.body];
  return candidates.find((param) => param.required) ?? candidates[0] ?? null;
}

export function generateScenarios(endpoint) {
  assertEndpoint(endpoint);

  const groups = classifyParams(endpoint);
  const allParams = [...groups.path, ...groups.query, ...groups.body];
  const validValues = validParamValues(allParams);
  const requiredParam = pickRequiredParam(groups);
  const invalidTarget = pickInvalidTarget(groups);
  const successStatus = successStatuses(endpoint.responses);

  const happyRequest = buildRequest(endpoint, groups, validValues, true);

  const sadValues = { ...validValues };
  for (const param of groups.path) {
    sadValues[param.name] = "recurso-inexistente-999999";
  }
  if (groups.path.length === 0 && requiredParam) {
    sadValues[requiredParam.name] = "recurso-inexistente-999999";
  }
  const sadRequest = buildRequest(endpoint, groups, sadValues, true);

  const invalidValues = { ...validValues };
  let invalidDescription = "Envia um parâmetro com tipo de dado incompatível.";

  const omitTarget = [...groups.query, ...groups.body].find((param) => param.required);
  if (omitTarget) {
    delete invalidValues[omitTarget.name];
    invalidDescription = "Omite um parâmetro obrigatório.";
  } else if (invalidTarget) {
    invalidValues[invalidTarget.name] = invalidValue(invalidTarget);
  }
  const invalidRequest = buildRequest(endpoint, groups, invalidValues, true);

  const noAuthRequest = buildRequest(endpoint, groups, validValues, false);

  return [
    {
      scenario_name: "happy_path",
      description: "Requisição com parâmetros válidos e autenticação quando exigida.",
      given: {
        endpoint: { method: endpoint.method, path: endpoint.path },
        authentication: buildAuth(endpoint, true),
        parameters: validValues,
      },
      when: {
        action: `${endpoint.method} ${happyRequest.path}`,
        request: happyRequest,
      },
      then: {
        expectedStatus: successStatus,
        outcome: "A API deve processar a requisição com sucesso.",
      },
    },
    {
      scenario_name: "sad_path",
      description: "Consulta ou manipula um recurso inexistente.",
      given: {
        endpoint: { method: endpoint.method, path: endpoint.path },
        authentication: buildAuth(endpoint, true),
        parameters: sadValues,
      },
      when: {
        action: `${endpoint.method} ${sadRequest.path}`,
        request: sadRequest,
      },
      then: {
        expectedStatus: ["404"],
        outcome: "A API deve informar que o recurso não foi encontrado.",
      },
    },
    {
      scenario_name: "invalid_data",
      description: invalidDescription,
      given: {
        endpoint: { method: endpoint.method, path: endpoint.path },
        authentication: buildAuth(endpoint, true),
        parameters: invalidValues,
      },
      when: {
        action: `${endpoint.method} ${invalidRequest.path}`,
        request: invalidRequest,
      },
      then: {
        expectedStatus: ["400", "422"],
        outcome: "A API deve rejeitar a requisição por erro de validação.",
      },
    },
    {
      scenario_name: "no_auth",
      description: endpoint.auth?.required
        ? "Envia a requisição sem token ou credencial de autenticação."
        : "Confirma o acesso ao endpoint público sem autenticação.",
      given: {
        endpoint: { method: endpoint.method, path: endpoint.path },
        authentication: null,
        parameters: validValues,
      },
      when: {
        action: `${endpoint.method} ${noAuthRequest.path}`,
        request: noAuthRequest,
      },
      then: {
        expectedStatus: endpoint.auth?.required ? ["401", "403"] : successStatus,
        outcome: endpoint.auth?.required
          ? "A API deve negar o acesso por falta de autenticação."
          : "A API deve permitir o acesso sem autenticação.",
      },
    },
  ];
}
