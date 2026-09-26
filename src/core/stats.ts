import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface OperationStat {
  count: number;
  cost: number;
  time_seconds: number;
  input_tokens: number;
  output_tokens: number;
  source?: "vex" | "jev" | string;
  provider?: "typesafe" | "openrouter" | string;
}

export interface SourceStat {
  count: number;
  cost: number;
  time_seconds: number;
  input_tokens: number;
  output_tokens: number;
}

export interface LocalStats {
  total_requests: number;
  total_cost: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_time_seconds: number;
  sources?: Record<string, SourceStat>;
  operations: Record<string, OperationStat>;
}

export interface OpenRouterKeyInfo {
  label?: string;
  limit?: number | null;
  limit_remaining?: number | null;
  usage?: number;
  [key: string]: unknown;
}

export interface OpenRouterCreditsInfo {
  total_credits?: number;
  total_usage?: number;
  [key: string]: unknown;
}

export interface OpenRouterAccountStats {
  key?: OpenRouterKeyInfo;
  credits?: OpenRouterCreditsInfo;
  key_error?: string;
  credits_error?: string;
}

export interface CombinedStatsReport {
  local: LocalStats;
  local_jev: LocalStats;
  openrouter_account: OpenRouterAccountStats;
}

export function getStatsFilePath(): string {
  return (
    process.env.VEX_STATS_PATH?.trim() ||
    process.env.JEV_STATS_PATH?.trim() ||
    join(homedir(), ".agents", "jev_stats.json")
  );
}

export function createEmptyStats(): LocalStats {
  return {
    total_requests: 0,
    total_cost: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_time_seconds: 0,
    sources: {
      vex: { count: 0, cost: 0, time_seconds: 0, input_tokens: 0, output_tokens: 0 },
      jev: { count: 0, cost: 0, time_seconds: 0, input_tokens: 0, output_tokens: 0 },
    },
    operations: {},
  };
}

export async function readLocalStats(customPath?: string): Promise<LocalStats> {
  const filePath = customPath ?? getStatsFilePath();
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LocalStats>;
    return {
      total_requests: Number(parsed.total_requests ?? 0),
      total_cost: Number(parsed.total_cost ?? 0),
      total_input_tokens: Number(parsed.total_input_tokens ?? 0),
      total_output_tokens: Number(parsed.total_output_tokens ?? 0),
      total_time_seconds: Number(parsed.total_time_seconds ?? 0),
      operations: parsed.operations ?? {},
      sources: parsed.sources ?? {},
    };
  } catch {
    return createEmptyStats();
  }
}

export interface RecordStatInput {
  operation: string;
  source?: "vex" | "jev" | string;
  provider?: "typesafe" | "openrouter" | string;
  elapsedSeconds: number;
  usage?: {
    cost?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
}

export async function recordStat(
  input: RecordStatInput,
  customPath?: string,
): Promise<void> {
  const filePath = customPath ?? getStatsFilePath();
  if (
    process.env.VITEST &&
    !customPath &&
    !process.env.VEX_STATS_PATH &&
    !process.env.JEV_STATS_PATH
  ) {
    return;
  }
  try {
    const stats = await readLocalStats(filePath);
    const cost = Number(input.usage?.cost ?? 0);
    const inputTokens = Number(input.usage?.input_tokens ?? 0);
    const outputTokens = Number(input.usage?.output_tokens ?? 0);
    const elapsed = Number(input.elapsedSeconds ?? 0);
    const source =
      input.source ?? (input.operation.startsWith("vex_") ? "vex" : "jev");

    stats.total_requests = (stats.total_requests || 0) + 1;
    stats.total_cost = (stats.total_cost || 0) + cost;
    stats.total_input_tokens = (stats.total_input_tokens || 0) + inputTokens;
    stats.total_output_tokens = (stats.total_output_tokens || 0) + outputTokens;
    stats.total_time_seconds = (stats.total_time_seconds || 0) + elapsed;

    if (!stats.operations) stats.operations = {};
    const existingOp = stats.operations[input.operation];
    const op: OperationStat = existingOp
      ? { ...existingOp }
      : {
          count: 0,
          cost: 0,
          time_seconds: 0,
          input_tokens: 0,
          output_tokens: 0,
          source,
          provider: input.provider,
        };
    op.count += 1;
    op.cost += cost;
    op.time_seconds += elapsed;
    op.input_tokens += inputTokens;
    op.output_tokens += outputTokens;
    op.source = source;
    if (input.provider) op.provider = input.provider;
    stats.operations[input.operation] = op;

    if (!stats.sources) stats.sources = {};
    const existingSrc = stats.sources[source];
    const src: SourceStat = existingSrc
      ? { ...existingSrc }
      : {
          count: 0,
          cost: 0,
          time_seconds: 0,
          input_tokens: 0,
          output_tokens: 0,
        };
    src.count += 1;
    src.cost += cost;
    src.time_seconds += elapsed;
    src.input_tokens += inputTokens;
    src.output_tokens += outputTokens;
    stats.sources[source] = src;

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(stats, null, 2), "utf8");
  } catch {
    // Record failure must never block operations
  }
}

export async function resetLocalStats(customPath?: string): Promise<boolean> {
  const filePath = customPath ?? getStatsFilePath();
  try {
    await unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function fetchAccountStats(
  apiKey: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenRouterAccountStats> {
  const result: OpenRouterAccountStats = {};
  if (!apiKey) return result;

  const headers = { Authorization: `Bearer ${apiKey}` };

  try {
    const keyRes = await fetchImpl("https://openrouter.ai/api/v1/auth/key", {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (keyRes.ok) {
      const data = (await keyRes.json()) as { data?: OpenRouterKeyInfo };
      result.key = data.data ?? {};
    } else {
      result.key_error = `HTTP ${keyRes.status}`;
    }
  } catch (err) {
    result.key_error = err instanceof Error ? err.message : String(err);
  }

  try {
    const creditsRes = await fetchImpl("https://openrouter.ai/api/v1/credits", {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (creditsRes.ok) {
      const data = (await creditsRes.json()) as {
        data?: OpenRouterCreditsInfo;
      };
      result.credits = data.data ?? {};
    } else {
      result.credits_error = `HTTP ${creditsRes.status}`;
    }
  } catch (err) {
    result.credits_error = err instanceof Error ? err.message : String(err);
  }

  return result;
}

export function formatStatsReport(
  local: LocalStats,
  remote: OpenRouterAccountStats,
): string {
  const lines: string[] = ["================ VEX & JEV STATS (COMBINED) ================"];

  // OpenRouter Account Section
  const key = remote.key;
  const credits = remote.credits;
  if (key || credits) {
    lines.push("OpenRouter Account:");
    if (key) {
      const label = key.label ?? "N/A";
      const limit = typeof key.limit === "number" ? `$${key.limit.toFixed(4)}` : "No limit";
      const rem =
        typeof key.limit_remaining === "number"
          ? `$${key.limit_remaining.toFixed(4)}`
          : "Unlimited";
      const usage = typeof key.usage === "number" ? `$${key.usage.toFixed(6)}` : "$0.000000";
      lines.push(`  - Key: ${label}`);
      lines.push(`  - Key Limit: ${limit} | Remaining: ${rem}`);
      lines.push(`  - Key Usage: ${usage}`);
    }
    if (credits) {
      const totCred =
        typeof credits.total_credits === "number"
          ? `$${credits.total_credits.toFixed(4)}`
          : "$0.0000";
      const totSpend =
        typeof credits.total_usage === "number"
          ? `$${credits.total_usage.toFixed(6)}`
          : "$0.000000";
      lines.push(`  - Total Credits: ${totCred} | Total Spend: ${totSpend}`);
    }
  } else if (remote.key_error || remote.credits_error) {
    lines.push("OpenRouter Account:");
    if (remote.key_error) lines.push(`  - Key Error: ${remote.key_error}`);
    if (remote.credits_error) lines.push(`  - Credits Error: ${remote.credits_error}`);
  }

  // Combined Activity Section
  const reqs = local.total_requests;
  const cost = local.total_cost;
  const inTok = local.total_input_tokens;
  const outTok = local.total_output_tokens;
  const totTime = local.total_time_seconds;
  const avgMs = reqs > 0 ? (totTime / reqs) * 1000 : 0;
  const avgCost = reqs > 0 ? cost / reqs : 0;

  let vexCalls = 0;
  let jevCalls = 0;
  if (local.sources && (local.sources.vex || local.sources.jev)) {
    vexCalls = local.sources.vex?.count ?? 0;
    jevCalls = local.sources.jev?.count ?? 0;
  } else {
    for (const [name, op] of Object.entries(local.operations ?? {})) {
      if (op.source === "vex" || name.startsWith("vex_")) vexCalls += op.count;
      else jevCalls += op.count;
    }
  }

  lines.push("");
  lines.push("Combined Engine Activity:");
  lines.push(`  - Total Calls: ${reqs} (Vex: ${vexCalls}, Jev: ${jevCalls})`);
  lines.push(`  - Total Spend: $${cost.toFixed(6)} (avg: $${avgCost.toFixed(6)}/call)`);
  lines.push(
    `  - Tokens: ${inTok.toLocaleString("en-US")} prompt in / ${outTok.toLocaleString("en-US")} decision out`,
  );
  lines.push(`  - Avg Latency: ${avgMs.toFixed(1)}ms (total time: ${totTime.toFixed(2)}s)`);

  const ops = Object.entries(local.operations ?? {});
  if (ops.length > 0) {
    lines.push("");
    lines.push("Operations Breakdown:");
    for (const [name, op] of ops.sort(([a], [b]) => a.localeCompare(b))) {
      const src =
        op.source ?? (name.startsWith("vex_") ? "vex" : "jev");
      const c = op.count;
      const co = op.cost;
      const t = op.time_seconds;
      const avgOpMs = c > 0 ? (t / c) * 1000 : 0;
      const label = `[${src}] ${name}`.padEnd(18);
      lines.push(
        `  - ${label}: ${c.toString().padStart(2)} calls | $${co.toFixed(6)} | avg ${avgOpMs.toFixed(1)}ms`,
      );
    }
  }

  lines.push("============================================================");
  return lines.join("\n");
}
