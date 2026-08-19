import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PROJECT_ROOT } from "../utils/paths.js";
import { classifyFailures } from "./failure-analyzer.js";

function parseAttribute(xml, name) {
  const match = xml.match(new RegExp(`${name}="([^"]*)"`));
  return match ? match[1] : null;
}

export function parseRobotOutput(xml = "") {
  const tests = [];
  const testBlocks = xml.matchAll(/<test\b([^>]*)>([\s\S]*?)<\/test>/gi);

  for (const block of testBlocks) {
    const name = parseAttribute(block[1], "name") ?? "unknown";
    const statusTag = block[2].match(/<status\b([^>]*)>([\s\S]*?)<\/status>/i);
    const status = statusTag ? parseAttribute(statusTag[1], "status") : "UNKNOWN";
    const message = statusTag ? (statusTag[2] || "").trim() : "";
    tests.push({
      test: name,
      status,
      message,
      line: null,
    });
  }

  const total = xml.match(/<stat[^>]*pass="(\d+)"[^>]*fail="(\d+)"[^>]*>All Tests<\/stat>/i)
    ?? xml.match(/<stat[^>]*fail="(\d+)"[^>]*pass="(\d+)"[^>]*>All Tests<\/stat>/i);

  let passed = tests.filter((test) => test.status === "PASS").length;
  let failed = tests.filter((test) => test.status === "FAIL").length;
  if (total) {
    const firstIsPass = /pass="/.test(total[0]) && total[0].indexOf("pass=") < total[0].indexOf("fail=");
    passed = Number(firstIsPass ? total[1] : total[2]);
    failed = Number(firstIsPass ? total[2] : total[1]);
  }

  return {
    passed,
    failed,
    tests,
    failures: tests.filter((test) => test.status === "FAIL"),
  };
}

function spawnCommand(command, args, cwd) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      shell: true,
      env: process.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolvePromise({ code: 127, stdout, stderr: error.message, command: [command, ...args].join(" ") });
    });
    child.on("close", (code) => {
      resolvePromise({ code: code ?? 1, stdout, stderr, command: [command, ...args].join(" ") });
    });
  });
}

async function countRobotFiles(testsDir) {
  const entries = await readdir(testsDir, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".robot")).length;
}

export async function runRobotTests({
  testsDir,
  outputDir,
} = {}) {
  const absoluteTests = resolve(PROJECT_ROOT, testsDir ?? "your-robot-project/tests/endpoints");
  const absoluteOutput = resolve(PROJECT_ROOT, outputDir ?? "your-robot-project/reports");

  if (!existsSync(absoluteTests)) {
    throw new Error(`Pasta de testes não encontrada: ${absoluteTests}`);
  }

  const robotCount = await countRobotFiles(absoluteTests);
  if (robotCount === 0) {
    throw new Error(`Nenhum .robot encontrado em ${absoluteTests}.`);
  }

  await mkdir(absoluteOutput, { recursive: true });

  const robotArgs = ["--outputdir", absoluteOutput, "--loglevel", "DEBUG", absoluteTests];
  const attempts = [
    ["robot", robotArgs],
    ["python", ["-m", "robot", ...robotArgs]],
    ["py", ["-m", "robot", ...robotArgs]],
  ];

  let lastResult = null;
  for (const [command, args] of attempts) {
    lastResult = await spawnCommand(command, args, PROJECT_ROOT);
    if (lastResult.code !== 127 && !/não (foi|é) reconhecido|not recognized|No module named robot/i.test(`${lastResult.stdout}\n${lastResult.stderr}`)) {
      break;
    }
  }

  if (!lastResult || /não (foi|é) reconhecido|not recognized|No module named robot/i.test(`${lastResult.stdout}\n${lastResult.stderr}`)) {
    throw new Error("Robot Framework não está instalado no PATH. Instale com: pip install robotframework robotframework-requests");
  }

  const outputXmlPath = join(absoluteOutput, "output.xml");
  let parsed = { passed: 0, failed: 0, tests: [], failures: [] };
  if (existsSync(outputXmlPath)) {
    parsed = parseRobotOutput(await readFile(outputXmlPath, "utf8"));
  } else if (lastResult.code !== 0) {
    throw new Error(`Falha ao executar Robot: ${lastResult.stderr || lastResult.stdout}`.trim());
  }

  const classified = classifyFailures(parsed.failures);

  return {
    testsDir: absoluteTests,
    outputDir: absoluteOutput,
    outputXml: outputXmlPath,
    command: lastResult.command,
    exitCode: lastResult.code,
    passed: parsed.passed,
    failed: parsed.failed,
    failures: classified,
    stdout: lastResult.stdout.slice(-4000),
    stderr: lastResult.stderr.slice(-2000),
  };
}
