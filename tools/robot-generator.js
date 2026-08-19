import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const SCENARIO_SUFFIX = {
  happy_path: "success",
  sad_path: "not_found",
  invalid_data: "invalid_data",
  no_auth: "no_auth",
};

function assertInput(scenarios, endpoint) {
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    throw new Error("scenarios deve ser um array não vazio.");
  }
  if (!endpoint?.method || !endpoint?.path) {
    throw new Error("endpoint inválido: method e path são obrigatórios.");
  }
}

function slugify(value) {
  return String(value)
    .replace(/^\//, "")
    .replace(/\{([^}]+)\}/g, "$1")
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function inferPathResource(path) {
  const parts = slugify(path).split("_").filter(Boolean);
  return parts[0] || "resource";
}

function inferSingularResource(path) {
  let resource = inferPathResource(path);

  if (resource.endsWith("s") && resource.length > 1) {
    resource = resource.slice(0, -1);
  }

  return resource;
}

function inferAction(method, path) {
  const resource = inferSingularResource(path);
  const hasPathParam = /\{[^}]+\}/.test(path);

  const actions = {
    GET: hasPathParam ? `retrieve_${resource}` : `list_${resource}`,
    POST: `create_${resource}`,
    PUT: `update_${resource}`,
    PATCH: `patch_${resource}`,
    DELETE: `delete_${resource}`,
  };

  return actions[method.toUpperCase()] ?? "call_api";
}

export function buildRobotFileName(endpoint, scenarioName = "happy_path") {
  const method = endpoint.method.toUpperCase();
  const resource = inferPathResource(endpoint.path);
  const action = inferAction(method, endpoint.path);
  const suffix = SCENARIO_SUFFIX[scenarioName] ?? slugify(scenarioName);

  return `${method}_${resource}_${action}_${suffix}.robot`;
}

function robotString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\$/g, "\\$");
}

function formatRobotScalar(value) {
  if (value === null || value === undefined) return "${NONE}";
  if (typeof value === "boolean") return value ? "${TRUE}" : "${FALSE}";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return `"${robotString(value)}"`;
  return `"${robotString(String(value))}"`;
}

function buildQuerySuffix(request) {
  if (!request.query || Object.keys(request.query).length === 0) {
    return "";
  }

  const params = Object.entries(request.query)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("&");

  return `?${params}`;
}

function buildAuthLines(scenario) {
  const authentication = scenario.given?.authentication;
  if (!authentication) {
    return ["    &{headers}=    Create Dictionary"];
  }

  if (authentication.type === "bearer") {
    return ["    &{headers}=    Criar Headers Autenticados    token=Bearer <token-valido>"];
  }

  if (authentication.type === "apiKey") {
    return [
      `    &{headers}=    Create Dictionary    ${authentication.name}=${robotString(authentication.value)}`,
    ];
  }

  return [
    `    &{headers}=    Create Dictionary    Authorization=${robotString(authentication.token ?? "<credencial-valida>")}`,
  ];
}

function buildBodyExecutionLines(request) {
  if (!request.body?.body) {
    return ["    ${body}=    Set Variable    ${NONE}"];
  }

  const payload = request.body.body;
  if (typeof payload !== "object" || Array.isArray(payload)) {
    return [`    \${body}=    Set Variable    ${formatRobotScalar(payload)}`];
  }

  const dictLines = Object.entries(payload).flatMap(([name, value]) => {
    if (typeof value === "number" || typeof value === "boolean") {
      return [`    ...    ${name}=${value}`];
    }
    return [`    ...    ${name}=${formatRobotScalar(value)}`];
  });

  return [
    "    &{payload}=    Create Dictionary",
    ...dictLines,
    "    ${body}=    Evaluate    json.dumps($payload)    json    json",
  ];
}

function buildSettingsSection(endpoint) {
  return [
    "*** Settings ***",
    `Documentation     Testes de API gerados para ${endpoint.method.toUpperCase()} ${endpoint.path}`,
    "Library           RequestsLibrary",
    "Library           Collections",
    "Library           BuiltIn",
    "Suite Setup       Configurar Sessao API",
    "Suite Teardown    Encerrar Sessao API",
    "Test Setup        Log    Iniciando cenario: ${TEST NAME}    console=True",
    "",
  ];
}

function buildVariablesSection(endpoint) {
  return [
    "*** Variables ***",
    "${BASE_URL}       %{API_BASE_URL=http://localhost:8080}",
    `\${ENDPOINT_METHOD}    ${endpoint.method.toUpperCase()}`,
    `\${ENDPOINT_PATH}      ${endpoint.path}`,
    "",
  ];
}

function buildKeywordsSection() {
  return [
    "*** Keywords ***",
    "Configurar Sessao API",
    "    Create Session    api    ${BASE_URL}    verify=${FALSE}",
    "",
    "Encerrar Sessao API",
    "    Delete All Sessions",
    "",
    "Criar Headers Autenticados",
    "    [Arguments]    ${token}=Bearer <token-valido>",
    "    &{headers}=    Create Dictionary    Authorization=${token}",
    "    [Return]    &{headers}",
    "",
    "Enviar Requisicao API",
    "    [Arguments]    ${method}    ${path}    &{headers}=${EMPTY}    ${body}=${NONE}",
    "    ${request_headers}=    Copy Dictionary    ${headers}",
    "    Run Keyword If    '${body}' != '${NONE}'    Set To Dictionary    ${request_headers}    Content-Type=application/json",
    "    ${has_body}=    Evaluate    '${body}' != '${NONE}'",
    "    ${response}=    Run Keyword If    ${has_body}    ${method} On Session    api    ${path}    headers=${request_headers}    json=${body}",
    "    ...    ELSE    Run Keyword    ${method} On Session    api    ${path}    headers=${request_headers}",
    "    [Return]    ${response}",
    "",
    "Validar Status HTTP",
    "    [Arguments]    ${response}    @{expected_status}",
    "    ${status}=    Convert To Integer    ${response.status_code}",
    "    ${expected_list}=    Create List    @{expected_status}",
    "    ${valid}=    Evaluate    $status in [int(code) for code in $expected_list]",
    "    Should Be True    ${valid}    Status recebido ${status}, esperado @{expected_status}",
    "",
    "Executar Cenario API",
    "    [Arguments]    ${method}    ${path}    &{headers}=${EMPTY}    ${body}=${NONE}    @{expected_status}",
    "    ${response}=    Enviar Requisicao API    ${method}    ${path}    &{headers}    ${body}",
    "    Validar Status HTTP    ${response}    @{expected_status}",
    "    [Return]    ${response}",
    "",
  ];
}

function buildTestCase(scenario, endpoint) {
  const request = scenario.when.request;
  const method = request.method.toUpperCase();
  const path = `${request.path}${buildQuerySuffix(request)}`;
  const expectedStatus = scenario.then.expectedStatus ?? ["200"];
  const tags = [
    scenario.scenario_name,
    endpoint.method.toLowerCase(),
    inferPathResource(endpoint.path),
    "api",
    "generated",
  ];
  const bodyArgument = request.body?.body ? "${body}" : "${NONE}";

  return [
    `${method} ${endpoint.path} - ${scenario.scenario_name}`,
    `    [Documentation]    ${scenario.description}`,
    `    ...    Given: ${JSON.stringify(scenario.given)}`,
    `    ...    When: ${scenario.when.action}`,
    `    ...    Then: ${scenario.then.outcome}`,
    `    [Tags]    ${tags.join("    ")}`,
    ...buildAuthLines(scenario),
    ...buildBodyExecutionLines(request),
    `    Executar Cenario API    ${method}    ${path}    &{headers}    ${bodyArgument}    ${expectedStatus.join("    ")}`,
    "",
  ];
}

function buildRobotContent(scenarios, endpoint) {
  return [
    ...buildSettingsSection(endpoint),
    ...buildVariablesSection(endpoint),
    ...buildKeywordsSection(),
    "*** Test Cases ***",
    ...scenarios.flatMap((scenario) => buildTestCase(scenario, endpoint)),
  ].join("\n");
}

export async function generateRobotTest(scenarios, endpoint, outputDir = "./robot-tests") {
  assertInput(scenarios, endpoint);

  const fileName = buildRobotFileName(endpoint, scenarios[0]?.scenario_name ?? "happy_path");
  const content = buildRobotContent(scenarios, endpoint);
  const absoluteOutputDir = resolve(outputDir);
  const filePath = join(absoluteOutputDir, fileName);

  await mkdir(absoluteOutputDir, { recursive: true });
  await writeFile(filePath, content, "utf8");

  return {
    fileName,
    filePath,
    content,
  };
}
