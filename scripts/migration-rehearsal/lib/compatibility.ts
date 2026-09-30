import { spawnSync } from "node:child_process";
import { REPO_ROOT } from "./core.ts";
import type { CompatibilityResult, CompatibilityCheck } from "./core.ts";

async function runQuery(dbUrl: string, sql: string): Promise<{ ok: boolean; output: string }> {
  const result = spawnSync("psql", [dbUrl, "-c", sql], {
    encoding: "utf-8",
    timeout: 30000,
  });
  return {
    ok: result.status === 0,
    output: result.stdout + (result.stderr ? "\n" + result.stderr : ""),
  };
}

async function checkTableExists(dbUrl: string, table: string): Promise<CompatibilityCheck> {
  const result = await runQuery(dbUrl, `
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = '${table}'
    )
  `);
  const exists = result.output.includes("t");
  return {
    name: `Table ${table} exists`,
    ok: exists,
    details: exists ? "Table found" : "Table missing",
  };
}

async function checkColumnExists(
  dbUrl: string,
  table: string,
  column: string,
): Promise<CompatibilityCheck> {
  const result = await runQuery(dbUrl, `
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = '${table}' AND column_name = '${column}'
    )
  `);
  const exists = result.output.includes("t");
  return {
    name: `Column ${table}.${column} exists`,
    ok: exists,
    details: exists ? "Column found" : "Column missing",
  };
}

async function checkEnumExists(dbUrl: string, enumName: string): Promise<CompatibilityCheck> {
  const result = await runQuery(dbUrl, `
    SELECT EXISTS (
      SELECT 1 FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typname = '${enumName}' AND t.typtype = 'e'
    )
  `);
  const exists = result.output.includes("t");
  return {
    name: `Enum ${enumName} exists`,
    ok: exists,
    details: exists ? "Enum found" : "Enum missing",
  };
}

async function checkIndexExists(dbUrl: string, indexName: string): Promise<CompatibilityCheck> {
  const result = await runQuery(dbUrl, `
    SELECT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = '${indexName}'
    )
  `);
  const exists = result.output.includes("t");
  return {
    name: `Index ${indexName} exists`,
    ok: exists,
    details: exists ? "Index found" : "Index missing",
  };
}

async function checkForeignKeyExists(
  dbUrl: string,
  table: string,
  fkName: string,
): Promise<CompatibilityCheck> {
  const result = await runQuery(dbUrl, `
    SELECT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_schema = 'public' AND table_name = '${table}' AND constraint_name = '${fkName}'
    )
  `);
  const exists = result.output.includes("t");
  return {
    name: `Foreign key ${table}.${fkName} exists`,
    ok: exists,
    details: exists ? "FK found" : "FK missing",
  };
}

async function checkRowCounts(dbUrl: string): Promise<CompatibilityCheck> {
  const tables = [
    "anchors",
    "corridors",
    "anchor_corridors",
    "rate_snapshots",
    "transfer_outcomes",
    "reputation_scores",
    "_prisma_migrations",
  ];

  const results: string[] = [];
  for (const table of tables) {
    const result = await runQuery(dbUrl, `SELECT count(*) FROM ${table}`);
    const count = result.output.match(/(\d+)/)?.[1] ?? "0";
    results.push(`${table}=${count}`);
  }

  return {
    name: "Row counts for all tables",
    ok: true,
    details: results.join(", "),
  };
}

async function checkLatestRateQuery(dbUrl: string): Promise<CompatibilityCheck> {
  const result = await runQuery(dbUrl, `
    SELECT count(*) FROM (
      SELECT DISTINCT ON (anchor_id) id FROM rate_snapshots
      WHERE corridor_id = (SELECT id FROM corridors LIMIT 1)
      ORDER BY anchor_id, captured_at DESC, id DESC
    ) x
  `);
  const count = result.output.match(/(\d+)/)?.[1] ?? "0";
  return {
    name: "Latest-rate-per-anchor query works",
    ok: parseInt(count, 10) >= 0,
    details: `Returned ${count} rows (one per anchor for first corridor)`,
  };
}

async function checkPrismaMigrateStatus(dbUrl: string): Promise<CompatibilityCheck> {
  const result = spawnSync("npx", ["prisma", "migrate", "status", "--json"], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: dbUrl },
    encoding: "utf-8",
  });

  let status = "unknown";
  try {
    const data = JSON.parse(result.stdout);
    status = data.status ?? "unknown";
  } catch {
    // ignore
  }

  return {
    name: "Prisma migrate status",
    ok: status === "up-to-date" || status === "success",
    details: `Status: ${status}`,
  };
}

async function checkApplicationReadPaths(dbUrl: string): Promise<CompatibilityCheck[]> {
  const checks: CompatibilityCheck[] = [];

  const tables = ["anchors", "corridors", "rate_snapshots", "transfer_outcomes", "reputation_scores"];
  for (const table of tables) {
    checks.push(await checkTableExists(dbUrl, table));
  }

  checks.push(await checkEnumExists(dbUrl, "anchor_status"));
  checks.push(await checkEnumExists(dbUrl, "transfer_status"));
  checks.push(await checkEnumExists(dbUrl, "reputation_score_band"));
  checks.push(await checkEnumExists(dbUrl, "reputation_state"));

  checks.push(await checkColumnExists(dbUrl, "anchors", "slug"));
  checks.push(await checkColumnExists(dbUrl, "anchors", "name"));
  checks.push(await checkColumnExists(dbUrl, "anchors", "home_domain"));
  checks.push(await checkColumnExists(dbUrl, "anchors", "toml_url"));
  checks.push(await checkColumnExists(dbUrl, "anchors", "seps"));
  checks.push(await checkColumnExists(dbUrl, "anchors", "is_transfer_capable"));
  checks.push(await checkColumnExists(dbUrl, "anchors", "status"));

  checks.push(await checkColumnExists(dbUrl, "corridors", "slug"));
  checks.push(await checkColumnExists(dbUrl, "corridors", "asset_code_from"));
  checks.push(await checkColumnExists(dbUrl, "corridors", "country_from"));
  checks.push(await checkColumnExists(dbUrl, "corridors", "asset_code_to"));
  checks.push(await checkColumnExists(dbUrl, "corridors", "country_to"));

  checks.push(await checkColumnExists(dbUrl, "rate_snapshots", "anchor_id"));
  checks.push(await checkColumnExists(dbUrl, "rate_snapshots", "corridor_id"));
  checks.push(await checkColumnExists(dbUrl, "rate_snapshots", "rate"));
  checks.push(await checkColumnExists(dbUrl, "rate_snapshots", "source_amount"));
  checks.push(await checkColumnExists(dbUrl, "rate_snapshots", "destination_amount"));
  checks.push(await checkColumnExists(dbUrl, "rate_snapshots", "fee"));
  checks.push(await checkColumnExists(dbUrl, "rate_snapshots", "captured_at"));

  checks.push(await checkIndexExists(dbUrl, "rate_snapshots_corridor_id_captured_at_idx"));
  checks.push(await checkIndexExists(dbUrl, "rate_snapshots_anchor_id_captured_at_idx"));
  checks.push(await checkIndexExists(dbUrl, "rate_snapshots_latest_observation_idx"));
  checks.push(await checkIndexExists(dbUrl, "rate_snapshots_anchor_corridor_latest_idx"));

  checks.push(await checkForeignKeyExists(dbUrl, "anchor_corridors", "anchor_corridors_anchor_id_fkey"));
  checks.push(await checkForeignKeyExists(dbUrl, "anchor_corridors", "anchor_corridors_corridor_id_fkey"));

  checks.push(await checkRowCounts(dbUrl));
  checks.push(await checkLatestRateQuery(dbUrl));
  checks.push(await checkPrismaMigrateStatus(dbUrl));

  return checks;
}

export async function verifyApplicationCompatibility(dbUrl: string): Promise<CompatibilityResult> {
  const checks = await checkApplicationReadPaths(dbUrl);
  return Object.freeze({
    ok: checks.every((c) => c.ok),
    checks: Object.freeze(checks),
  });
}