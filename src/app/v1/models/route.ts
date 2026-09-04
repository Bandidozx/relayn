/**
 * GET /v1/models — OpenAI-compatible model listing, scoped to the caller's plan.
 *
 * Only enabled models whose `minPlan` the caller's subscription satisfies are returned,
 * so a Free key never discovers (or tries to call) a Business-tier model. Extra Relayn
 * metadata is namespaced so OpenAI SDKs that expect `{id, object, created, owned_by}`
 * keep working.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { clientIp } from "@/lib/api/http";
import { assertRateLimit, authenticate, type GatewayIdentity } from "@/lib/gateway/pipeline";
import { handleFailure, type FailureContext } from "@/lib/gateway/respond";
import { planSatisfies } from "@/lib/plans";
import { newRequestId } from "@/lib/security/tokens";

const ENDPOINT = "/v1/models";

export const dynamic = "force-dynamic";

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204 });
}

export async function GET(request: Request): Promise<Response> {
  const startedAt = Date.now();
  const requestId = newRequestId();

  const failure: FailureContext = {
    identity: null,
    requestId,
    endpoint: ENDPOINT,
    modelId: "",
    provider: "",
    startedAt,
    streamed: false,
    ipAddress: clientIp(request),
    request,
  };

  let identity: GatewayIdentity;
  try {
    identity = await authenticate(request);
    failure.identity = identity;
  } catch (error) {
    return handleFailure(error, failure);
  }

  try {
    assertRateLimit(identity);

    const models = await prisma.aiModel.findMany({
      where: { enabled: true },
      orderBy: [{ sortOrder: "asc" }, { modelId: "asc" }],
    });

    const plan = identity.subscription.plan;
    const visible = models.filter((model) => planSatisfies(plan, model.minPlan));

    return NextResponse.json(
      {
        object: "list",
        data: visible.map((model) => ({
          id: model.modelId,
          object: "model",
          created: Math.floor(model.createdAt.getTime() / 1000),
          owned_by: model.provider,
          relayn: {
            name: model.name,
            category: model.category,
            description: model.description,
            context_window: model.contextWindow,
            max_output_tokens: model.maxOutputTokens,
            input_price_per_1m_usd: model.inputPrice,
            output_price_per_1m_usd: model.outputPrice,
            capabilities: model.capabilities
              ? model.capabilities.split(",").map((entry) => entry.trim()).filter(Boolean)
              : [],
            min_plan: model.minPlan,
          },
        })),
      },
      { headers: { "x-request-id": requestId } },
    );
  } catch (error) {
    return handleFailure(error, failure);
  }
}
