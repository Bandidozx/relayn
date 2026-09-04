/**
 * Database seed.
 *
 * Creates the provider registry rows, the model catalogue, and — unless
 * SEED_DEMO_DATA=false — two demo accounts with clearly marked sample traffic.
 *
 * Sample usage rows carry a `req_seed_...` request id and are surfaced in the UI with a
 * "sample" chip, so demo data can never be mistaken for production statistics.
 *
 *   npm run db:seed
 */
import "dotenv/config";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { hashPassword } from "../src/lib/security/password.ts";
import { generateApiKey } from "../src/lib/security/tokens.ts";
import { PLANS, nextRenewalDate } from "../src/lib/plans.ts";

const databaseUrl = process.env.DATABASE_URL ?? "file:./dev.db";
const isPostgres = databaseUrl.startsWith("postgres");
const prisma = new PrismaClient({
  adapter: isPostgres
    ? new PrismaPg({ connectionString: databaseUrl })
    : new PrismaBetterSqlite3({ url: databaseUrl.replace(/^file:/, "") }),
});

const seedDemo = (process.env.SEED_DEMO_DATA ?? "true").toLowerCase() !== "false";
const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD ?? "relayn-demo-2026";

interface CatalogueEntry {
  modelId: string;
  name: string;
  provider: string;
  category: string;
  description: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputPrice: number;
  outputPrice: number;
  capabilities: string;
  minPlan: string;
  enabled: boolean;
  upstreamModel?: string;
  sortOrder: number;
}

/**
 * Prices are USD per 1M tokens and are seeded DEFAULTS only — an operator should
 * confirm them against their upstream contract in Admin → Models before going live.
 */
const CATALOGUE: CatalogueEntry[] = [
  {
    modelId: "relayn-sandbox-chat",
    name: "Sandbox Chat",
    provider: "mock",
    category: "chat",
    description:
      "Deterministic in-process model. Answers immediately with no upstream credential, so you can verify auth, streaming and accounting end to end.",
    contextWindow: 32_000,
    maxOutputTokens: 4_096,
    inputPrice: 0,
    outputPrice: 0,
    capabilities: "streaming,tools",
    minPlan: "free",
    enabled: true,
    sortOrder: 0,
  },
  {
    modelId: "relayn-sandbox-reasoner",
    name: "Sandbox Reasoner",
    provider: "mock",
    category: "reasoning",
    description:
      "Sandbox model with a priced tier, useful for exercising cost accounting and budget runway projections without spending anything real.",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    inputPrice: 0.5,
    outputPrice: 1.5,
    capabilities: "streaming,reasoning",
    minPlan: "free",
    enabled: true,
    sortOrder: 1,
  },
  {
    modelId: "relayn-sandbox-coder",
    name: "Sandbox Coder",
    provider: "mock",
    category: "coding",
    description:
      "Sandbox model tagged as a coding tier so plan gating and per-category filters can be tested.",
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
    inputPrice: 0.25,
    outputPrice: 1.0,
    capabilities: "streaming,tools,long-context",
    minPlan: "pro",
    enabled: true,
    sortOrder: 2,
  },
  {
    modelId: "claude-opus-5",
    name: "Claude Opus 5",
    provider: "anthropic",
    category: "reasoning",
    description:
      "Anthropic's flagship reasoning model. Routed through the native /v1/messages dialect.",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    inputPrice: 15,
    outputPrice: 75,
    capabilities: "streaming,tools,vision,reasoning",
    minPlan: "business",
    enabled: true,
    sortOrder: 10,
  },
  {
    modelId: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    provider: "anthropic",
    category: "chat",
    description: "Balanced Anthropic model for production chat, agents and tool use.",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    inputPrice: 3,
    outputPrice: 15,
    capabilities: "streaming,tools,vision",
    minPlan: "pro",
    enabled: true,
    sortOrder: 11,
  },
  {
    modelId: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    provider: "anthropic",
    category: "chat",
    description: "Fast, inexpensive Anthropic model for classification and short turns.",
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    inputPrice: 1,
    outputPrice: 5,
    capabilities: "streaming,tools,vision",
    minPlan: "free",
    enabled: true,
    sortOrder: 12,
  },
  {
    modelId: "gpt-4o",
    name: "GPT-4o",
    provider: "openai",
    category: "vision",
    description: "OpenAI multimodal chat model with image input and tool calling.",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    inputPrice: 2.5,
    outputPrice: 10,
    capabilities: "streaming,tools,vision",
    minPlan: "pro",
    enabled: true,
    sortOrder: 20,
  },
  {
    modelId: "gpt-4o-mini",
    name: "GPT-4o mini",
    provider: "openai",
    category: "chat",
    description: "Small, cheap OpenAI model for high-volume routing.",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    inputPrice: 0.15,
    outputPrice: 0.6,
    capabilities: "streaming,tools,vision",
    minPlan: "free",
    enabled: true,
    sortOrder: 21,
  },
  {
    modelId: "o3",
    name: "o3",
    provider: "openai",
    category: "reasoning",
    description: "OpenAI reasoning model for multi-step analysis and planning.",
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    inputPrice: 2,
    outputPrice: 8,
    capabilities: "streaming,tools,reasoning",
    minPlan: "business",
    enabled: true,
    sortOrder: 22,
  },
  {
    modelId: "text-embedding-3-large",
    name: "Embedding 3 Large",
    provider: "openai",
    category: "embeddings",
    description:
      "Embedding model. Catalogue + pricing only in this release; /v1/embeddings is not implemented yet.",
    contextWindow: 8_191,
    maxOutputTokens: 0,
    inputPrice: 0.13,
    outputPrice: 0,
    capabilities: "embeddings",
    minPlan: "pro",
    enabled: false,
    sortOrder: 23,
  },
  {
    modelId: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    provider: "google",
    category: "reasoning",
    description: "Google long-context reasoning model via the OpenAI-compatible endpoint.",
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    inputPrice: 1.25,
    outputPrice: 10,
    capabilities: "streaming,tools,vision,long-context",
    minPlan: "pro",
    enabled: true,
    sortOrder: 30,
  },
  {
    modelId: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    provider: "google",
    category: "chat",
    description: "Fast Google model with a very large context window.",
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    inputPrice: 0.3,
    outputPrice: 2.5,
    capabilities: "streaming,tools,vision,long-context",
    minPlan: "free",
    enabled: true,
    sortOrder: 31,
  },
  {
    modelId: "deepseek-chat",
    name: "DeepSeek Chat",
    provider: "openrouter",
    category: "chat",
    description: "Open-weight general chat model, routed via OpenRouter.",
    contextWindow: 64_000,
    maxOutputTokens: 8_192,
    inputPrice: 0.14,
    outputPrice: 0.28,
    capabilities: "streaming,tools,open-weights",
    minPlan: "free",
    enabled: true,
    upstreamModel: "deepseek/deepseek-chat",
    sortOrder: 40,
  },
  {
    modelId: "deepseek-reasoner",
    name: "DeepSeek Reasoner",
    provider: "openrouter",
    category: "reasoning",
    description: "Open-weight reasoning model with visible chain-of-thought budget.",
    contextWindow: 64_000,
    maxOutputTokens: 8_192,
    inputPrice: 0.55,
    outputPrice: 2.19,
    capabilities: "streaming,reasoning,open-weights",
    minPlan: "free",
    enabled: true,
    upstreamModel: "deepseek/deepseek-r1",
    sortOrder: 41,
  },
  {
    modelId: "qwen-2.5-coder-32b",
    name: "Qwen 2.5 Coder 32B",
    provider: "openrouter",
    category: "coding",
    description: "Open-weight coding model, strong on fill-in-the-middle completions.",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    inputPrice: 0.18,
    outputPrice: 0.18,
    capabilities: "streaming,open-weights",
    minPlan: "free",
    enabled: true,
    upstreamModel: "qwen/qwen-2.5-coder-32b-instruct",
    sortOrder: 42,
  },
  {
    modelId: "llama-3.3-70b",
    name: "Llama 3.3 70B",
    provider: "openrouter",
    category: "chat",
    description: "Meta's open-weight instruction model for general assistants.",
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
    inputPrice: 0.23,
    outputPrice: 0.4,
    capabilities: "streaming,tools,open-weights",
    minPlan: "free",
    enabled: true,
    upstreamModel: "meta-llama/llama-3.3-70b-instruct",
    sortOrder: 43,
  },
  {
    modelId: "mistral-large",
    name: "Mistral Large",
    provider: "openrouter",
    category: "chat",
    description: "European-hosted general model with strong multilingual coverage.",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    inputPrice: 2,
    outputPrice: 6,
    capabilities: "streaming,tools",
    minPlan: "pro",
    enabled: true,
    upstreamModel: "mistralai/mistral-large",
    sortOrder: 44,
  },
];

const PROVIDERS = [
  {
    provider: "mock",
    label: "Relayn Sandbox",
    envVar: "ENABLE_MOCK_PROVIDER",
    baseUrl: null,
    notes: "In-process deterministic provider for development, tests and demos.",
  },
  {
    provider: "openai",
    label: "OpenAI",
    envVar: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    notes: "OpenAI /chat/completions dialect.",
  },
  {
    provider: "anthropic",
    label: "Anthropic",
    envVar: "ANTHROPIC_API_KEY",
    baseUrl: "https://api.anthropic.com/v1",
    notes: "Native /v1/messages dialect.",
  },
  {
    provider: "google",
    label: "Google AI Studio",
    envVar: "GOOGLE_API_KEY",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    notes: "OpenAI-compatible compatibility layer.",
  },
  {
    provider: "openrouter",
    label: "OpenRouter",
    envVar: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
    notes: "Aggregator used for open-weight models.",
  },
];

function pick<T>(items: T[], index: number): T {
  return items[index % items.length]!;
}

async function seedCatalogue(): Promise<void> {
  for (const provider of PROVIDERS) {
    await prisma.providerConfig.upsert({
      where: { provider: provider.provider },
      update: { label: provider.label, envVar: provider.envVar, baseUrl: provider.baseUrl, notes: provider.notes },
      create: {
        provider: provider.provider,
        label: provider.label,
        envVar: provider.envVar,
        baseUrl: provider.baseUrl,
        notes: provider.notes,
        enabled: true,
      },
    });
  }

  for (const entry of CATALOGUE) {
    const { upstreamModel, ...rest } = entry;
    await prisma.aiModel.upsert({
      where: { modelId: entry.modelId },
      update: { ...rest, upstreamModel: upstreamModel ?? null },
      create: { ...rest, upstreamModel: upstreamModel ?? null },
    });
  }
  console.log(`✓ catalogue: ${PROVIDERS.length} providers, ${CATALOGUE.length} models`);
}

interface SeededUser {
  id: string;
  email: string;
  plan: keyof typeof PLANS;
}

async function seedUser(
  email: string,
  name: string,
  role: "user" | "admin",
  plan: keyof typeof PLANS,
): Promise<SeededUser> {
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const user = await prisma.user.upsert({
    where: { email },
    update: { name, role, passwordHash, status: "active", emailVerifiedAt: new Date() },
    create: { email, name, role, passwordHash, status: "active", emailVerifiedAt: new Date() },
  });

  await prisma.subscription.upsert({
    where: { userId: user.id },
    update: { plan, tokenAllocation: PLANS[plan].tokenAllocation, status: "active" },
    create: {
      userId: user.id,
      plan,
      status: "active",
      tokenAllocation: PLANS[plan].tokenAllocation,
      tokensUsed: 0,
      renewalDate: nextRenewalDate(),
    },
  });

  return { id: user.id, email, plan };
}

/** Deterministic demo key so the README can document a working curl example. */
async function seedApiKeys(userId: string, label: string): Promise<string | null> {
  const existing = await prisma.apiKey.findFirst({ where: { userId, name: label } });
  if (existing) return null;

  const generated = generateApiKey();
  await prisma.apiKey.create({
    data: {
      userId,
      name: label,
      keyHash: generated.hash,
      keyPrefix: generated.prefix,
      last4: generated.last4,
      status: "active",
    },
  });
  return generated.secret;
}

/**
 * Sample traffic for the demo account. Rows are marked with a `req_seed_` request id;
 * the usage table renders a "sample" chip for them so they are never confused with
 * live production statistics.
 */
async function seedUsage(userId: string): Promise<void> {
  const existing = await prisma.usageLog.count({ where: { userId, requestId: { startsWith: "req_seed_" } } });
  if (existing > 0) {
    console.log("• sample usage already present, skipping");
    return;
  }

  const keys = await prisma.apiKey.findMany({ where: { userId } });
  if (keys.length === 0) return;

  const models = await prisma.aiModel.findMany({
    where: { modelId: { in: ["relayn-sandbox-chat", "relayn-sandbox-reasoner", "gpt-4o-mini", "claude-haiku-4-5", "deepseek-chat"] } },
  });
  if (models.length === 0) return;

  const endpoints = ["/v1/chat/completions", "/v1/chat/completions", "/v1/chat/completions", "/v1/messages"];
  const errorCodes = ["upstream_rate_limited", "model_unavailable", "invalid_request"];
  const rows: Array<Parameters<typeof prisma.usageLog.create>[0]["data"]> = [];

  const days = 14;
  let totalTokens = 0;
  let sequence = 0;

  for (let dayOffset = days - 1; dayOffset >= 0; dayOffset -= 1) {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    dayStart.setDate(dayStart.getDate() - dayOffset);

    // A weekday-shaped volume curve that ramps up over the window.
    const weekday = dayStart.getDay();
    const weekendFactor = weekday === 0 || weekday === 6 ? 0.35 : 1;
    const ramp = 0.55 + ((days - dayOffset) / days) * 0.8;
    const requests = Math.max(2, Math.round(14 * weekendFactor * ramp));

    for (let index = 0; index < requests; index += 1) {
      sequence += 1;
      const model = pick(models, sequence * 7 + dayOffset);
      const key = pick(keys, sequence);
      const isError = sequence % 23 === 0;
      const hour = 8 + ((sequence * 3) % 12);
      const createdAt = new Date(dayStart);
      createdAt.setHours(hour, (sequence * 11) % 60, (sequence * 17) % 60, 0);

      const inputTokens = isError ? 0 : 180 + ((sequence * 37) % 900);
      const outputTokens = isError ? 0 : 90 + ((sequence * 53) % 700);
      const total = inputTokens + outputTokens;
      totalTokens += total;

      const cost = Math.round(
        ((inputTokens * model.inputPrice) / 1_000_000 + (outputTokens * model.outputPrice) / 1_000_000) *
          1_000_000,
      );

      rows.push({
        userId,
        apiKeyId: key.id,
        modelId: model.modelId,
        provider: model.provider,
        endpoint: pick(endpoints, sequence),
        requestId: `req_seed_${dayOffset.toString().padStart(2, "0")}_${sequence.toString().padStart(4, "0")}`,
        inputTokens,
        outputTokens,
        totalTokens: total,
        latencyMs: isError ? 120 + ((sequence * 13) % 300) : 320 + ((sequence * 29) % 2600),
        status: isError ? "error" : "success",
        httpStatus: isError ? 502 : 200,
        errorCode: isError ? pick(errorCodes, sequence) : null,
        errorMessage: isError ? "Upstream provider returned an error for this sample request." : null,
        costMicroUsd: cost,
        streamed: sequence % 3 === 0,
        ipAddress: "127.0.0.1",
        createdAt,
      });
    }
  }

  for (const data of rows) {
    await prisma.usageLog.create({ data });
  }

  // Counters must agree with the logs, exactly as the live gateway maintains them.
  await prisma.subscription.update({
    where: { userId },
    data: { tokensUsed: rows.filter((r) => r.status === "success").reduce((sum, r) => sum + (r.totalTokens ?? 0), 0) },
  });

  for (const key of keys) {
    const keyRows = rows.filter((row) => row.apiKeyId === key.id);
    const billed = keyRows.filter((row) => row.status === "success");
    await prisma.apiKey.update({
      where: { id: key.id },
      data: {
        requestCount: keyRows.length,
        totalTokens: billed.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0),
        lastUsedAt: keyRows.length > 0 ? new Date() : null,
      },
    });
  }

  console.log(`✓ sample usage: ${rows.length} requests, ${totalTokens.toLocaleString()} tokens`);
}

async function seedSupportAndIntegrations(userId: string): Promise<void> {
  const ticketCount = await prisma.supportTicket.count({ where: { userId } });
  if (ticketCount === 0) {
    const ticket = await prisma.supportTicket.create({
      data: {
        userId,
        subject: "Raise the per-minute request ceiling on my Pro key",
        category: "billing",
        priority: "normal",
        status: "pending",
        message:
          "We are running a nightly batch job that briefly exceeds 60 requests per minute. Can the ceiling be lifted for the production key?",
      },
    });
    await prisma.ticketMessage.create({
      data: {
        ticketId: ticket.id,
        authorId: userId,
        authorRole: "admin",
        body: "Thanks for writing in — we can lift this on Business. I have flagged the account for review and will follow up here.",
      },
    });
    await prisma.supportTicket.create({
      data: {
        userId,
        subject: "Streaming responses truncate behind our proxy",
        category: "technical",
        priority: "high",
        status: "resolved",
        message:
          "SSE responses stop after roughly 8KB when routed through our corporate proxy. Direct calls are fine.",
      },
    });
  }

  const integrationCount = await prisma.integration.count({ where: { userId } });
  if (integrationCount === 0) {
    const key = await prisma.apiKey.findFirst({ where: { userId, status: "active" } });
    await prisma.integration.create({
      data: {
        userId,
        type: "openai-sdk-python",
        name: "Batch summariser (Python)",
        apiKeyId: key?.id ?? null,
        configuration: JSON.stringify({ defaultModel: "relayn-sandbox-chat", stream: false }),
      },
    });
    await prisma.integration.create({
      data: {
        userId,
        type: "cursor",
        name: "Cursor — team workspace",
        apiKeyId: key?.id ?? null,
        configuration: JSON.stringify({ defaultModel: "claude-sonnet-5", baseUrlOverride: false }),
      },
    });
  }
}

async function main(): Promise<void> {
  await seedCatalogue();

  if (!seedDemo) {
    console.log("• SEED_DEMO_DATA=false — catalogue only, no demo accounts");
    return;
  }

  const admin = await seedUser("admin@relayn.dev", "Ada Relay", "admin", "enterprise");
  const demo = await seedUser("demo@relayn.dev", "Dev Sandbox", "user", "pro");

  const productionKey = await seedApiKeys(demo.id, "Production");
  const stagingKey = await seedApiKeys(demo.id, "Staging");
  await seedApiKeys(admin.id, "Admin console");

  await seedUsage(demo.id);
  await seedSupportAndIntegrations(demo.id);

  await prisma.auditLog.create({
    data: {
      userId: admin.id,
      actorEmail: admin.email,
      action: "admin.model_updated",
      targetType: "seed",
      targetId: "catalogue",
      metadata: JSON.stringify({ models: CATALOGUE.length, source: "prisma/seed.ts" }),
      ipAddress: "127.0.0.1",
    },
  });

  console.log("\n─── demo accounts ───────────────────────────────────────────");
  console.log(`  admin  admin@relayn.dev   password: ${DEMO_PASSWORD}`);
  console.log(`  user   demo@relayn.dev    password: ${DEMO_PASSWORD}`);
  if (productionKey || stagingKey) {
    console.log("\n─── API keys (shown once, hashes stored) ────────────────────");
    if (productionKey) console.log(`  Production  ${productionKey}`);
    if (stagingKey) console.log(`  Staging     ${stagingKey}`);
    console.log("\n  Try it:");
    console.log(`    curl ${process.env.APP_URL ?? "http://localhost:3200"}/v1/chat/completions \\`);
    console.log(`      -H "Authorization: Bearer ${productionKey ?? stagingKey}" \\`);
    console.log('      -H "Content-Type: application/json" \\');
    console.log('      -d \'{"model":"relayn-sandbox-chat","messages":[{"role":"user","content":"Hello"}]}\'');
  }
  console.log("");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });


