import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..", "..", "..");

export type MigrationStatus = "pending" | "applied" | "rolled_back" | "failed";

export type MigrationRecord = Readonly<{
  id: string;
  checksum: string;
  finishedAt: Date | null;
  migrationName: string;
  logs: string;
  rolledBackAt: Date | null;
  startedAt: Date;
  appliedStepsCount: number;
}>;

export type RehearsalScenario = Readonly<{
  id: string;
  name: string;
  description: string;
  failurePoint: "before" | "during" | "after";
  setup: (dbUrl: string) => Promise<void>;
  verify: (dbUrl: string) => Promise<VerificationResult>;
  recovery: (dbUrl: string) => Promise<RecoveryResult>;
}>;

export type VerificationResult = Readonly<{
  ok: boolean;
  checks: readonly CheckResult[];
  summary: string;
}>;

export type CheckResult = Readonly<{
  name: string;
  ok: boolean;
  details: string;
}>;

export type RecoveryResult = Readonly<{
  strategy: "rollback" | "forward_fix" | "restore" | "manual";
  success: boolean;
  steps: readonly string[];
  warnings: readonly string[];
}>;

export type RehearsalReport = Readonly<{
  scenarioId: string;
  scenarioName: string;
  timestamp: string;
  databaseUrl: string;
  initialState: MigrationRecord[];
  failureState: MigrationRecord[];
  verification: VerificationResult;
  recovery: RecoveryResult;
  finalState: MigrationRecord[];
  compatibility: CompatibilityResult;
}>;

export type CompatibilityResult = Readonly<{
  ok: boolean;
  checks: readonly CompatibilityCheck[];
}>;

export type CompatibilityCheck = Readonly<{
  name: string;
  ok: boolean;
  details: string;
}>;

export type RehearsalConfig = Readonly<{
  databaseUrl: string;
  outputDir: string;
  dryRun: boolean;
}>;

function assertNotProduction(dbUrl: string): void {
  const url = new URL(dbUrl);
  const host = url.hostname.toLowerCase();
  const prodIndicators = ["prod", "production", "live", "main", "primary"];
  if (prodIndicators.some((ind) => host.includes(ind))) {
    throw new Error(
      `SAFETY VIOLATION: Database host "${host}" appears to be production. Rehearsal refused.`,
    );
  }
  if (url.searchParams.get("sslmode") === "require" && host.includes("prisma")) {
    throw new Error(
      `SAFETY VIOLATION: Database appears to be managed Prisma production. Rehearsal refused.`,
    );
  }
}

async function getMigrationHistory(dbUrl: string): Promise<MigrationRecord[]> {
  const result = spawnSync("npx", ["prisma", "migrate", "status", "--json"], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: dbUrl },
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    throw new Error(
      `Failed to get migration status: ${result.stderr ?? result.stdout}`,
    );
  }

  try {
    const data = JSON.parse(result.stdout);
    return data.appliedMigrations ?? [];
  } catch {
    return [];
  }
}

async function runMigration(
  dbUrl: string,
  options: string[] = [],
): Promise<{ success: boolean; output: string }> {
  const args = ["prisma", "migrate", "deploy", ...options];
  const result = spawnSync("npx", args, {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: dbUrl },
    encoding: "utf-8",
    timeout: 60000,
  });

  return {
    success: result.status === 0,
    output: result.stdout + (result.stderr ? "\n" + result.stderr : ""),
  };
}

async function runSql(dbUrl: string, sql: string): Promise<void> {
  const result = spawnSync("psql", [dbUrl, "-c", sql], {
    encoding: "utf-8",
    timeout: 30000,
  });
  if (result.status !== 0) {
    throw new Error(`SQL failed: ${result.stderr ?? result.stdout}`);
  }
}

function createOutputDir(baseDir: string, scenarioId: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(baseDir, `${scenarioId}-${timestamp}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(file: string, data: unknown): void {
  writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}

function readSql(file: string): string {
  return readFileSync(file, "utf-8");
}

export const CORE_UTILS = Object.freeze({
  assertNotProduction,
  getMigrationHistory,
  runMigration,
  runSql,
  createOutputDir,
  writeJson,
  readSql,
  REPO_ROOT,
});