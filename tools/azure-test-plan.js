import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import axios from "axios";
import { decodeHtml, extractHttpCall } from "../utils/http-path.js";
import { PROJECT_ROOT } from "../utils/paths.js";

const API_VERSION = "7.1";

function azureAuthHeader(pat) {
  return `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;
}

function parseStepsXml(xml = "") {
  const steps = [];
  const stepBlocks = String(xml).matchAll(/<step\b[^>]*>([\s\S]*?)<\/step>/gi);

  for (const block of stepBlocks) {
    const strings = [...block[1].matchAll(/<parameterizedString\b[^>]*>([\s\S]*?)<\/parameterizedString>/gi)]
      .map((match) => decodeHtml(match[1]));
    steps.push({
      action: strings[0] ?? "",
      expected: strings[1] ?? "",
    });
  }

  return steps;
}

function fieldValue(fields, name) {
  if (!fields) return undefined;
  if (Array.isArray(fields)) {
    const entry = fields.find((field) => field?.name === name || field?.referenceName === name);
    return entry?.value ?? entry?.[name];
  }
  return fields[name];
}

function normalizeCase(item) {
  const workItem = item.workItem ?? item;
  const fields = workItem.fields ?? workItem.workItemFields ?? {};
  const id = workItem.id ?? fieldValue(fields, "System.Id") ?? item.id;
  const title = workItem.name
    ?? fieldValue(fields, "System.Title")
    ?? item.title
    ?? "";
  const tagsRaw = fieldValue(fields, "System.Tags") ?? item.tags ?? "";
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw
    : String(tagsRaw).split(/[;,]/).map((tag) => tag.trim()).filter(Boolean);
  const steps = item.steps ?? parseStepsXml(fieldValue(fields, "Microsoft.VSTS.TCM.Steps") ?? "");
  const linkedRequirement = item.linkedRequirement
    ?? fieldValue(fields, "System.IterationPath")
    ?? null;

  const searchable = [title, ...steps.map((step) => `${step.action} ${step.expected}`)].join(" ");

  return {
    id: Number(id) || id,
    title,
    steps,
    tags,
    linkedRequirement,
    httpHint: extractHttpCall(searchable),
  };
}

async function readLocalSuite(source) {
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

  const cases = Array.isArray(document) ? document : document.cases ?? document.value ?? [];
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error("Nenhum caso de teste encontrado no arquivo local.");
  }

  return {
    source: absolutePath,
    organization: document.organization ?? null,
    project: document.project ?? null,
    planId: document.planId ?? null,
    suiteId: document.suiteId ?? null,
    cases: cases.map(normalizeCase),
  };
}

async function azureGet(url, pat) {
  try {
    const response = await axios.get(url, {
      timeout: 20_000,
      headers: {
        Authorization: azureAuthHeader(pat),
        Accept: "application/json",
      },
    });
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      throw new Error(`Plan ou suite não encontrados (${url}).`);
    }
    if (axios.isAxiosError(error) && (error.response?.status === 401 || error.response?.status === 403)) {
      throw new Error("Credencial Azure inválida ou sem permissão (401/403).");
    }
    throw error;
  }
}

async function fetchWorkItems(baseUrl, pat, ids) {
  if (ids.length === 0) return [];
  const chunks = [];
  for (let index = 0; index < ids.length; index += 200) {
    chunks.push(ids.slice(index, index + 200));
  }

  const items = [];
  for (const chunk of chunks) {
    const url = `${baseUrl}/_apis/wit/workitems?ids=${chunk.join(",")}&$expand=all&api-version=${API_VERSION}`;
    const data = await azureGet(url, pat);
    items.push(...(data.value ?? []));
  }
  return items;
}

export async function readAzureTestPlan({
  organization,
  project,
  planId,
  suiteId,
  pat,
  source,
} = {}) {
  if (source) {
    return readLocalSuite(source);
  }

  if (!organization || !project || planId === undefined || suiteId === undefined) {
    throw new Error("Informe organization, project, planId e suiteId — ou um arquivo local em source.");
  }
  if (!pat) {
    throw new Error("Informe o PAT do Azure (argumento pat ou AZURE_PAT no .env).");
  }

  const baseUrl = `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}`;
  const listUrl = `${baseUrl}/_apis/testplan/Plans/${planId}/Suites/${suiteId}/TestCase?api-version=${API_VERSION}`;
  const listing = await azureGet(listUrl, pat);
  const listed = listing.value ?? [];

  if (listed.length === 0) {
    throw new Error("A suite Azure não contém casos de teste.");
  }

  const ids = listed
    .map((item) => item.workItem?.id ?? item.testCase?.id ?? item.id)
    .filter(Boolean);
  const workItems = await fetchWorkItems(baseUrl, pat, ids);
  const byId = new Map(workItems.map((item) => [item.id, item]));

  const cases = listed.map((item) => {
    const id = item.workItem?.id ?? item.id;
    return normalizeCase(byId.get(id) ?? item);
  });

  return {
    source: listUrl,
    organization,
    project,
    planId: Number(planId) || planId,
    suiteId: Number(suiteId) || suiteId,
    cases,
  };
}
