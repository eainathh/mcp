const RULES = [
  {
    type: "auth_error",
    action: "Ajustar auth.resource / variáveis API_TOKEN no .env",
    pattern: /\b(401|403|unauthorized|forbidden)\b/i,
  },
  {
    type: "wrong_payload",
    action: "Usar body/headers da collection Postman",
    pattern: /\b(400|422|bad request|unprocessable)\b/i,
  },
  {
    type: "missing_data",
    action: "Executar query Python de setup (db_helpers.py)",
    pattern: /\b(404|not found)\b/i,
  },
  {
    type: "connection",
    action: "Verificar API_BASE_URL e se a API está no ar",
    pattern: /timeout|timed out|econnrefused|connection refused|failed to establish|max retries/i,
  },
  {
    type: "wrong_status",
    action: "Revisar step Azure vs status real da API",
    pattern: /status recebido|esperado|status code|expected status/i,
  },
];

export function classifyFailure(failure = {}) {
  const haystack = `${failure.message ?? ""} ${failure.test ?? ""}`;
  const rule = RULES.find((item) => item.pattern.test(haystack));
  return {
    test: failure.test,
    message: failure.message,
    line: failure.line ?? null,
    type: rule?.type ?? "unknown",
    action: rule?.action ?? "Analisar o log do Robot e corrigir o código gerado",
  };
}

export function classifyFailures(failures = []) {
  return failures.map(classifyFailure);
}

export function analyzeFailures({ failures, outputXml } = {}) {
  const items = classifyFailures(failures ?? []);
  const byType = {};
  for (const item of items) {
    byType[item.type] = (byType[item.type] ?? 0) + 1;
  }

  return {
    outputXml: outputXml ?? null,
    failed: items.length,
    byType,
    failures: items,
    scope: "Corrigir apenas arquivos gerados (.robot, resources, db_helpers.py). Não alterar o MCP.",
  };
}
