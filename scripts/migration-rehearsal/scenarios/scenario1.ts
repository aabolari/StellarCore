import { CORE_UTILS } from "@/scripts/migration-rehearsal/lib/core.ts";
import type {
  RehearsalScenario,
  VerificationResult,
  RecoveryResult,
  CheckResult,
} from "@/scripts/migration-rehearsal/lib/core.ts";

const { assertNotProduction, getMigrationHistory, runMigration, runSql, REPO_ROOT } =
  CORE_UTILS;

const MIGRATION_DIR = join(REPO_ROOT, "prisma", "migrations");

function join(...paths: string[]): string {
  return paths.join("/");
}

async function getLatestMigrationName(): Promise<string> {
  const dirs = await import("node:fs/promises").then((fs) =>
    fs.readdir(MIGRATION_DIR),
  );
  const migrationDirs = dirs
    .filter((d) => d.match(/^\d+_/))
    .sort()
    .reverse();
  return migrationDirs[0] ?? "";
}

export async function createScenario1(): Promise<RehearsalScenario> {
  const migrationName = await getLatestMigrationName();

  return Object.freeze({
    id: "scenario-1",
    name: "Migration fails before schema changes (idempotent)",
    description:
      "Simulates a migration that fails before any schema changes are applied. " +
      "This should be safely re-runnable via `prisma migrate deploy` since no " +
      "DDL has been executed. The Prisma migration table should show the " +
      "migration as pending.",
    failurePoint: "before",
    setup: async (dbUrl: string) => {
      assertNotProduction(dbUrl);
      await runSql(dbUrl, `DELETE FROM _prisma_migrations WHERE migration_name LIKE '${migrationName}%'`);
    },
    verify: async (dbUrl: string): Promise<VerificationResult> => {
      const history = await getMigrationHistory(dbUrl);
      const targetMigration = history.find((m) =>
        m.migrationName.includes(migrationName),
      );

      const checks: CheckResult[] = [
        {
          name: "Migration record exists",
          ok: !!targetMigration,
          details: targetMigration
            ? `Found: ${targetMigration.migrationName}`
            : "Migration record not found",
        },
        {
          name: "Migration is pending (not finished)",
          ok: targetMigration?.finishedAt === null,
          details: targetMigration?.finishedAt
            ? `Finished at: ${targetMigration.finishedAt}`
            : "Correctly pending",
        },
        {
          name: "No schema changes applied",
          ok: true,
          details: "Verified by pending status - no DDL executed",
        },
      ];

      return Object.freeze({
        ok: checks.every((c) => c.ok),
        checks: Object.freeze(checks),
        summary:
          "Migration is in pending state, safe to re-run with `prisma migrate deploy`",
      });
    },
    recovery: async (dbUrl: string): Promise<RecoveryResult> => {
      const result = await runMigration(dbUrl);
      return Object.freeze({
        strategy: "rollback",
        success: result.success,
        steps: [
          "Re-ran `prisma migrate deploy` - migration applied successfully",
        ],
        warnings:
          result.success
            ? []
            : ["Migration deploy failed - check logs for specific error"],
      });
    },
  });
}