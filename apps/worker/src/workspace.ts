import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveWithinRoot } from "./paths.js";

export interface JobWorkspace {
  root: string;
  input: string;
  candidate: string;
  verification: string;
  output: string;
  logs: string;
  jobPath: string;
  sceneSpecPath: string;
  expectedManifestPath: string;
  buildPlanPath: string;
  candidatePath: string;
  manifestPath: string;
  outputPath: string;
  executionReportPath: string;
  failureReportPath: string;
  buildResultPath: string;
  verificationResultPath: string;
}

export function createJobWorkspace(workspaceRoot: string, jobId: string): JobWorkspace {
  const root = resolveWithinRoot(workspaceRoot, jobId);
  const input = join(root, "input");
  const candidate = join(root, "candidate");
  const verification = join(root, "verification");
  const output = join(root, "output");
  const logs = join(root, "logs");

  for (const transientDirectory of [input, candidate, verification, logs]) {
    if (existsSync(transientDirectory))
      rmSync(transientDirectory, { recursive: true, force: true });
    mkdirSync(transientDirectory, { recursive: true });
  }
  mkdirSync(output, { recursive: true });

  return {
    root,
    input,
    candidate,
    verification,
    output,
    logs,
    jobPath: join(input, "job.json"),
    sceneSpecPath: join(input, "scene-spec.json"),
    expectedManifestPath: join(input, "expected-scene-manifest.json"),
    buildPlanPath: join(logs, "build-plan.json"),
    candidatePath: join(candidate, "project.max"),
    manifestPath: join(verification, "scene-manifest.json"),
    outputPath: join(output, "project.max"),
    executionReportPath: join(output, "execution-report.json"),
    failureReportPath: join(logs, "execution-report.json"),
    buildResultPath: join(logs, "build-result.json"),
    verificationResultPath: join(logs, "verification-result.json"),
  };
}

export function writeDeterministicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "w" });
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function promoteCandidate(candidatePath: string, outputPath: string): void {
  if (!existsSync(candidatePath)) throw new Error("Candidate scene is missing");
  const temporaryPath = `${outputPath}.tmp`;
  try {
    copyFileSync(candidatePath, temporaryPath);
    const descriptor = openSync(temporaryPath, "r+");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporaryPath, outputPath);
  } catch (error) {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
    throw error;
  }
}
