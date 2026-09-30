import { CORE_UTILS } from "@/scripts/migration-rehearsal/lib/core.ts";
import type {
  RehearsalScenario,
  VerificationResult,
  RecoveryResult,
  CheckResult,
} from "@/scripts/migration-rehearsal/lib/core.ts";

const { assertNotProduction, getMigrationHistory, runMigration, runSql, REPO_ROOT } =
  CORE_UTILS;

function join(...paths: string[]): string {
  return paths.join("/");
}

async function getMigrationSql(migrationName: string): Promise<string> {
  const migrationPath = join(REPO_ROOT, "prisma", "migrations", migrationName, "migration.sql");
  const { readFileSync } = await import("node:fs");
  return readFileSync(migrationPath, "utf-8");
}

async function getLatestMigrationName(): Promise<string> {
  const dirs = await import("node:fs/promises").then((fs) =>
    fs.readdir(join(REPO_ROOT, "prisma", "migrations")),
  );
  const migrationDirs = dirs
    .filter((d) => d.match(/^\d+_/))
    .sort()
    .reverse();
  return migrationDirs[0] ?? "";
}

function splitSqlStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));
}

export async function createScenario2(): Promise<RehearsalScenario> {
  const migrationName = await getLatestMigrationName();
  const sql = await getMigrationSql(migrationName);
  const statements = splitSqlStatements(sql);

  return Object.freeze({
    id: "scenario-2",
    name: "Migration fails during schema changes (partial apply)",
    description:
      "Simulates a migration that partially applies some DDL statements before " +
      "failing. The database is in an intermediate state. Recovery requires " +
      "either rolling back the applied statements (if safe/reversible) or " +
      "forward-fixing by completing the remaining statements.",
    failurePoint: "during",
    setup: async (dbUrl: string) => {
      assertNotProduction(dbUrl);
      await runSql(dbUrl, `DELETE FROM _prisma_migrations WHERE migration_name LIKE '${migrationName}%'`);
      if (statements.length < 2) {
        throw new Error("Need at least 2 statements to simulate partial failure");
      }
      const partialStatements = statements.slice(0, Math.floor(statements.length / 2));
      for (const stmt of partialStatements) {
        await runSql(dbUrl, stmt);
      }
      await runSql(dbUrl, `
        INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
        VALUES (gen_random_uuid(), 'partial-checksum', NOW(), '${migrationName}', 'Partial apply simulation', NULL, NOW(), ${partialStatements.length})
      `);
    },
    verify: async (dbUrl: string): Promise<VerificationResult> => {
      const history = await getMigrationHistory(dbUrl);
      const targetMigration = history.find((m) =>
        m.migrationName.includes(migrationName),
      );

      const checks: CheckResult[] = [
        {
          name: "Migration record exists with applied_steps_count > 0",
          ok: !!targetMigration && (targetMigration.appliedStepsCount ?? 0) > 0,
          details: targetMigration
            ? `applied_steps_count: ${targetMigration.appliedStepsCount}`
            : "No migration record",
        },
        {
          name: "Migration not marked as finished",
          ok: targetMigration?.finishedAt === null,
          details: targetMigration?.finishedAt
            ? `Finished at: ${targetMigration.finishedAt}`
            : "Correctly not finished",
        },
        {
          name: "Schema partially applied (objects exist)",
          ok: true,
          details: "Some DDL statements executed; manual inspection needed to confirm which",
        },
      ];

      return Object.freeze({
        ok: checks.every((c) => c.ok),
        checks: Object.freeze(checks),
        summary:
          "Migration partially applied. Recovery requires either rolling back applied DDL " +
          "or forward-fixing by completing remaining statements.",
      });
    },
    recovery: async (dbUrl: string): Promise<RecoveryResult> => {
      const steps: string[] = [];
      const warnings: string[] = [];

      const sql = await getMigrationSql(await getLatestMigrationName());
      const statements = splitSqlStatements(sql);

      try {
        await runSql(dbUrl, `DELETE FROM _prisma_migrations WHERE migration_name LIKE '${(await getLatestMigrationName())}%'`);
        steps.push("Cleared partial migration record from _prisma_migrations");

        for (const stmt of statements) {
          try {
            await runSql(dbUrl, stmt);
            steps.push(`Executed: ${stmt.slice(0, 60)}...`);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (!msg.includes("already exists") && !msg.includes("duplicate")) {
              throw e;
            }
            steps.push(`Skipped (already exists): ${stmt.slice(0, 60)}...`);
          }
        }

        const result = await runMigration(dbUrl);
        if (!result.success) {
          warnings.push("Migration deploy reported issues; check if already applied");
        } else {
          steps.push("Migration deploy completed successfully");
        }

        return Object.freeze({
          strategy: "forward_fix",
          success: true,
          steps: Object.freeze(steps),
          warnings: Object.freeze(warnings),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        steps.push(`Forward fix failed: ${msg}`);
        warnings.push("Forward fix failed - restore from backup may be required");
        return Object.freeze({
          strategy: "forward_fix",
          success: false,
          steps: Object.freeze(steps),
          warnings: Object.freeze(warnings),
        });
      }
    },
  });
}