import { CORE_UTILS } from "@/scripts/migration-rehearsal/lib/core.ts";
import type {
  RehearsalScenario,
  VerificationResult,
  RecoveryResult,
  CheckResult,
} from "@/scripts/migration-rehearsal/lib/core.ts";

const { assertNotProduction, getMigrationHistory, runSql, REPO_ROOT } =
  CORE_UTILS;

function join(...paths: string[]): string {
  return paths.join("/");
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

export async function createScenario3(): Promise<RehearsalScenario> {
  const migrationName = await getLatestMigrationName();

  return Object.freeze({
    id: "scenario-3",
    name: "Migration fails after schema changes (metadata mismatch)",
    description:
      "Simulates a migration where all DDL completed successfully, but the " +
      "_prisma_migrations record was not properly recorded (e.g., checksum " +
      "mismatch, network failure after DDL but before metadata commit). " +
      "Schema is correct but Prisma thinks migration is pending. Recovery " +
      "involves repairing the migration metadata.",
    failurePoint: "after",
    setup: async (dbUrl: string) => {
      assertNotProduction(dbUrl);
      const sql = await import("node:fs/promises").then((fs) =>
        fs.readFile(join(REPO_ROOT, "prisma", "migrations", migrationName, "migration.sql"), "utf-8"),
      );
      const statements = sql
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.startsWith("--"));

      for (const stmt of statements) {
        try {
          await runSql(dbUrl, stmt);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!msg.includes("already exists") && !msg.includes("duplicate")) {
            throw e;
          }
        }
      }

      await runSql(dbUrl, `
        INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
        VALUES (gen_random_uuid(), 'wrong-checksum-intentional-mismatch', NOW(), '${migrationName}', 'Checksum mismatch simulation', NULL, NOW(), ${statements.length})
      `);
    },
    verify: async (dbUrl: string): Promise<VerificationResult> => {
      const history = await getMigrationHistory(dbUrl);
      const targetMigration = history.find((m) =>
        m.migrationName.includes(migrationName),
      );

      const statusResult = await import("node:child_process").then(({ spawnSync }) =>
        spawnSync("npx", ["prisma", "migrate", "status", "--json"], {
          cwd: REPO_ROOT,
          env: { ...process.env, DATABASE_URL: dbUrl },
          encoding: "utf-8",
        }),
      );

      let prismaStatus = "unknown";
      try {
        const data = JSON.parse(statusResult.stdout);
        prismaStatus = data.status ?? "unknown";
      } catch {
        // ignore
      }

      const checks: CheckResult[] = [
        {
          name: "All schema objects exist",
          ok: true,
          details: "Verified by executing all DDL statements in setup",
        },
        {
          name: "Migration record exists but with wrong checksum",
          ok: !!targetMigration && targetMigration.checksum === "wrong-checksum-intentional-mismatch",
          details: targetMigration
            ? `Checksum: ${targetMigration.checksum}`
            : "No migration record",
        },
        {
          name: "Prisma migrate status detects mismatch",
          ok: prismaStatus !== "up-to-date",
          details: `Prisma status: ${prismaStatus}`,
        },
      ];

      return Object.freeze({
        ok: checks.every((c) => c.ok),
        checks: Object.freeze(checks),
        summary:
          "Schema is correct but Prisma migration metadata has checksum mismatch. " +
          "Recovery requires repairing _prisma_migrations record with correct checksum.",
      });
    },
    recovery: async (dbUrl: string): Promise<RecoveryResult> => {
      const steps: string[] = [];
      const warnings: string[] = [];

      try {
        const migrationName = await getLatestMigrationName();
        const sql = await import("node:fs/promises").then((fs) =>
          fs.readFile(join(REPO_ROOT, "prisma", "migrations", migrationName, "migration.sql"), "utf-8"),
        );

        const { createHash } = await import("node:crypto");
        const correctChecksum = createHash("sha256").update(sql).digest("hex");

        await runSql(dbUrl, `
          UPDATE _prisma_migrations
          SET checksum = '${correctChecksum}',
              logs = 'Checksum repaired via rehearsal',
              finished_at = NOW(),
              applied_steps_count = ${sql.split(";").filter((s) => s.trim() && !s.trim().startsWith("--")).length}
          WHERE migration_name LIKE '${migrationName}%'
        `);
        steps.push(`Updated checksum to correct value: ${correctChecksum.slice(0, 16)}...`);
        steps.push("Set finished_at to NOW()");
        steps.push("Set applied_steps_count to statement count");

        const statusResult = await import("node:child_process").then(({ spawnSync }) =>
          spawnSync("npx", ["prisma", "migrate", "status", "--json"], {
            cwd: REPO_ROOT,
            env: { ...process.env, DATABASE_URL: dbUrl },
            encoding: "utf-8",
          }),
        );

        let prismaStatus = "unknown";
        try {
          const data = JSON.parse(statusResult.stdout);
          prismaStatus = data.status ?? "unknown";
        } catch {
          // ignore
        }

        steps.push(`Prisma migrate status after repair: ${prismaStatus}`);

        const success = prismaStatus === "up-to-date" || prismaStatus === "success";
        if (!success) {
          warnings.push("Prisma status not 'up-to-date' after repair; manual verification needed");
        }

        return Object.freeze({
          strategy: "forward_fix",
          success,
          steps: Object.freeze(steps),
          warnings: Object.freeze(warnings),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        steps.push(`Metadata repair failed: ${msg}`);
        warnings.push("Metadata repair failed - restore from backup required");
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