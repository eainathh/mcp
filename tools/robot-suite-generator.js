import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inferAction, inferPathResource, inferSingularResource, slugify } from "../utils/http-path.js";
import { PROJECT_ROOT } from "../utils/paths.js";
import { resolveConcretePath } from "./matcher.js";
import { loadPatterns } from "./pattern-loader.js";

function interpolate(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? "");
}

function robotEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\$/g, "\\$");
}

function jsonForRobot(value) {
  return JSON.stringify(value ?? null);
}

function needsDb(match, queries = []) {
  const blob = [match.title, ...(match.tags ?? []), ...match.steps.map((step) => `${step.action} ${step.expected}`)]
    .join(" ")
    .toLowerCase();
  const mentionsDb = /banco|sql|database|massa/.test(blob);
  if (!mentionsDb) return false;
  return queries.filter((query) => query.name.includes(match.resource));
}

function scenarioSuffix(match, patterns) {
  const failed = match.expectedStatus.some((code) => !/^2/.test(String(code)));
  if (failed) return "error";
  return patterns.naming.scenario_default ?? "success";
}

function fileNameFor(match, patterns) {
  return interpolate(patterns.naming.test_file, {
    method: match.endpoint.method,
    resource: inferPathResource(match.endpoint.path),
    action: inferAction(match.endpoint.method, match.endpoint.path),
    scenario: `tc${match.azureTestId}`,
  });
}

function testCaseName(match, patterns) {
  return interpolate(patterns.naming.test_case, {
    method: match.endpoint.method,
    path: match.endpoint.path,
    azure_test_id: String(match.azureTestId),
    resource: match.resource,
  });
}

function tagsFor(match, patterns) {
  const tags = [...(patterns.tags?.required ?? [])];
  if (patterns.tags?.from_azure) tags.push(...(match.tags ?? []));
  tags.push(match.endpoint.method.toLowerCase(), match.resource);
  return [...new Set(tags.map((tag) => slugify(tag) || tag).filter(Boolean))];
}

function commonResource() {
  return `*** Settings ***
Library           RequestsLibrary
Library           Collections
Library           OperatingSystem
Library           BuiltIn

*** Keywords ***
Configurar Sessao API
    \${base_url}=    Get Environment Variable    API_BASE_URL    default=http://localhost:8080
    Create Session    api    \${base_url}    verify=\${FALSE}

Encerrar Sessao API
    Delete All Sessions

Enviar Requisicao API
    [Arguments]    \${method}    \${path}    \${headers}=\${None}    \${body}=\${None}
    \${request_headers}=    Run Keyword If    '\${headers}' != '\${None}'    Copy Dictionary    \${headers}
    ...    ELSE    Create Dictionary
    \${has_body}=    Evaluate    $body is not None
    IF    \${has_body}
        Set To Dictionary    \${request_headers}    Content-Type=application/json
        \${response}=    Run Keyword    \${method} On Session    api    \${path}    headers=\${request_headers}    json=\${body}
    ELSE
        \${response}=    Run Keyword    \${method} On Session    api    \${path}    headers=\${request_headers}
    END
    RETURN    \${response}
`;
}

function authResource(patterns) {
  const envToken = patterns.auth?.env_token ?? "API_TOKEN";
  const header = patterns.auth?.header ?? "Authorization";
  const scheme = patterns.auth?.scheme ?? "Bearer";
  return `*** Settings ***
Library           OperatingSystem
Library           Collections
Resource          common.resource

*** Keywords ***
Obter Token
    \${token}=    Get Environment Variable    ${envToken}    default=\${EMPTY}
    RETURN    \${token}

Criar Headers Autenticados
    \${token}=    Obter Token
    &{headers}=    Create Dictionary    ${header}=${scheme} \${token}
    RETURN    &{headers}
`;
}

function validationResource() {
  return `*** Keywords ***
Validar Status HTTP
    [Arguments]    \${response}    @{expected_status}
    \${status}=    Convert To Integer    \${response.status_code}
    \${expected_list}=    Create List    @{expected_status}
    \${valid}=    Evaluate    $status in [int(code) for code in $expected_list]
    Should Be True    \${valid}    Status recebido \${status}, esperado @{expected_status}
`;
}

function stepKeywordName(match) {
  const action = inferAction(match.endpoint.method, match.endpoint.path);
  return action
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function stepsResource(resource, matches) {
  const keywords = matches.map((match) => {
    const name = stepKeywordName(match);
    return `${name}
    [Arguments]    \${path}    \${headers}    \${body}=\${None}
    \${response}=    Enviar Requisicao API    ${match.endpoint.method}    \${path}    \${headers}    \${body}
    RETURN    \${response}`;
  });

  return `*** Settings ***
Resource          ../common.resource

*** Keywords ***
${[...new Map(keywords.map((block) => [block.split("\n")[0], block])).values()].join("\n\n")}
`;
}

function testFileContent(match, patterns, relativeLib, dbQueries) {
  const tags = tagsFor(match, patterns);
  const path = resolveConcretePath(match);
  const query = match.postman?.query ?? {};
  const queryString = Object.keys(query).length
    ? `?${new URLSearchParams(query).toString()}`
    : "";
  const hasBody = match.postman?.body && typeof match.postman.body === "object";
  const documentation = [
    match.title,
    `Azure Test Case: ${match.azureTestId}`,
    ...match.steps.map((step) => `Dado/Quando: ${step.action} | Então: ${step.expected}`),
  ].join("\n    ...    ");

  const extraLibraries = dbQueries.length
    ? [`Library           ${relativeLib}`]
    : [];
  const setupLines = dbQueries
    .filter((queryItem) => /^(get|fetch|setup)_/.test(queryItem.name))
    .slice(0, 1)
    .map((queryItem) => `    \${db_setup}=    ${queryItem.name}    1`);
  const teardownLines = dbQueries
    .filter((queryItem) => /^(cleanup|delete|teardown)_/.test(queryItem.name))
    .slice(0, 1)
    .map((queryItem) => `    ${queryItem.name}    1`);

  const bodyLines = hasBody
    ? [
        `    \${body}=    Evaluate    json.loads('''${robotEscape(jsonForRobot(match.postman.body))}''')    json`,
      ]
    : ["    ${body}=    Set Variable    ${None}"];

  const headerLines = Object.entries(match.postman?.headers ?? {}).some(([name]) =>
    name.toLowerCase() === "authorization",
  ) || match.swagger?.requiresAuth
    ? ["    ${headers}=    Criar Headers Autenticados"]
    : ["    ${headers}=    Create Dictionary"];

  return `*** Settings ***
Documentation     ${documentation}
${(patterns.structure.settings ?? []).join("\n")}
Resource          ../resources/steps/${match.resource}_steps.resource
Resource          ../resources/steps/validation_steps.resource
${extraLibraries.join("\n")}
Suite Setup       Configurar Sessao API
Suite Teardown    Encerrar Sessao API

*** Test Cases ***
${testCaseName(match, patterns)}
    [Documentation]    ${match.title}
    [Tags]    ${tags.join("    ")}
${setupLines.join("\n")}
${headerLines.join("\n")}
${bodyLines.join("\n")}
    \${response}=    ${stepKeywordName(match)}    ${path}${queryString}    \${headers}    \${body}
    Validar Status HTTP    \${response}    ${match.expectedStatus.join("    ")}
${teardownLines.join("\n")}
`;
}

export async function generateRobotSuite({
  matches,
  patternsPath = "patterns/company.yaml",
  outputRoot,
  queries = [],
} = {}) {
  if (!matches?.matched?.length) {
    throw new Error("Nenhum cenário casado para gerar. Execute match_scenarios primeiro.");
  }

  const loaded = await loadPatterns(patternsPath);
  const patterns = loaded.patterns;
  const root = resolve(PROJECT_ROOT, outputRoot ?? patterns.structure.output_root);
  const endpointsDir = join(root, patterns.structure.endpoints_dir);
  const resourcesDir = join(root, patterns.structure.keywords_dir);
  const stepsDir = join(root, patterns.structure.steps_dir);
  const dataDir = join(root, patterns.structure.data_dir);
  const libDir = join(root, patterns.structure.lib_dir);

  await mkdir(endpointsDir, { recursive: true });
  await mkdir(resourcesDir, { recursive: true });
  await mkdir(stepsDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(libDir, { recursive: true });

  const files = [];
  const write = async (filePath, content) => {
    await writeFile(filePath, content.trimStart(), "utf8");
    files.push(filePath);
  };

  await write(join(resourcesDir, "common.resource"), commonResource());
  await write(join(resourcesDir, "auth.resource"), authResource(patterns));
  await write(join(stepsDir, "validation_steps.resource"), validationResource());

  const byResource = new Map();
  for (const match of matches.matched) {
    const list = byResource.get(match.resource) ?? [];
    list.push(match);
    byResource.set(match.resource, list);
  }

  for (const [resource, resourceMatches] of byResource) {
    await write(join(stepsDir, `${resource}_steps.resource`), stepsResource(resource, resourceMatches));
    const sample = resourceMatches.find((item) => item.postman?.body)?.postman.body ?? null;
    await write(join(dataDir, `${resource}.json`), JSON.stringify(sample ?? {}, null, 2));
  }

  const relativeLib = `../../${patterns.structure.lib_dir}/db_helpers.py`.replaceAll("\\", "/");

  for (const match of matches.matched) {
    const dbQueries = needsDb(match, queries) || [];
    const content = testFileContent(match, patterns, relativeLib, dbQueries);
    await write(join(endpointsDir, fileNameFor(match, patterns)), content);
  }

  return {
    patternsPath: loaded.path,
    outputRoot: root,
    endpointsDir,
    reportsDir: join(root, patterns.structure.reports_dir),
    files,
    generated: matches.matched.length,
    unmatched: matches.unmatched ?? [],
  };
}
