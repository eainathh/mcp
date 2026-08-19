import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { PROJECT_ROOT } from "../utils/paths.js";

const PARAM_PATTERN = /[:$]\{?([A-Za-z_][\w]*)\}?|\{([A-Za-z_][\w]*)\}/g;

function functionNameFromFile(fileName) {
  return basename(fileName, extname(fileName))
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function extractParams(sql) {
  const names = [];
  for (const match of sql.matchAll(PARAM_PATTERN)) {
    const name = match[1] || match[2];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function pythonFunction(name, params, sql) {
  const escapedSql = sql.trim().replace(/\\/g, "\\\\").replace(/"""/g, '\\"""');
  const args = params.length ? params.join(", ") : "";
  const paramTuple = params.length ? `(${params.join(", ")},)` : "()";
  const sqlLiteral = escapedSql.replace(PARAM_PATTERN, "%s");

  return `
def ${name}(${args}):
    rows = execute_query("""${sqlLiteral}""", ${paramTuple})
    return rows[0] if rows else {}
`.trim();
}

function pythonModule(functions) {
  return `"""Helpers de banco gerados a partir das queries SQL do projeto."""
import os
from typing import Any


def _connect():
    try:
        import psycopg2
        import psycopg2.extras
    except ImportError as error:
        raise RuntimeError("Instale psycopg2-binary para usar helpers de banco.") from error

    return psycopg2.connect(
        host=os.environ.get("DB_HOST", "localhost"),
        port=os.environ.get("DB_PORT", "5432"),
        dbname=os.environ.get("DB_NAME", "postgres"),
        user=os.environ.get("DB_USER", "postgres"),
        password=os.environ.get("DB_PASSWORD", ""),
    )


def execute_query(sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    connection = _connect()
    try:
        from psycopg2.extras import RealDictCursor

        with connection.cursor(cursor_factory=RealDictCursor) as cursor:
            cursor.execute(sql, params)
            if cursor.description:
                return [dict(row) for row in cursor.fetchall()]
            connection.commit()
            return []
    finally:
        connection.close()


${functions.join("\n\n")}
`;
}

export async function loadQueries(queriesDir = "queries", outputFile) {
  const absoluteDir = resolve(PROJECT_ROOT, queriesDir);
  const entries = await readdir(absoluteDir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") {
      throw new Error(`Pasta de queries não encontrada: ${absoluteDir}`);
    }
    throw error;
  });

  const sqlFiles = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".sql"));
  if (sqlFiles.length === 0) {
    throw new Error(`Nenhum arquivo .sql encontrado em ${absoluteDir}.`);
  }

  const queries = [];
  const functions = [];

  for (const file of sqlFiles) {
    const filePath = join(absoluteDir, file.name);
    const sql = await readFile(filePath, "utf8");
    const name = functionNameFromFile(file.name);
    const params = extractParams(sql);
    queries.push({ name, file: filePath, params, sql: sql.trim() });
    functions.push(pythonFunction(name, params, sql));
  }

  const pythonPath = outputFile
    ? resolve(PROJECT_ROOT, outputFile)
    : resolve(PROJECT_ROOT, "your-robot-project/lib/db_helpers.py");

  await mkdir(resolve(pythonPath, ".."), { recursive: true });
  await writeFile(pythonPath, pythonModule(functions), "utf8");

  return {
    directory: absoluteDir,
    pythonPath,
    queries,
    functions: queries.map((query) => query.name),
  };
}
