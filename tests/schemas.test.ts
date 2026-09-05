/**
 * Input validation. Every mutating route parses through one of these schemas before it
 * touches the database, so what is asserted here is the boundary: what is normalised, what
 * is rejected, and which defaults a caller gets when they omit a field.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  adminModelSyncSchema,
  adminProviderCreateSchema,
  adminProviderTestSchema,
  adminProviderUpdateSchema,
  adminSubscriptionSchema,
  changePasswordSchema,
  createApiKeySchema,
  deleteAccountSchema,
  loginSchema,
  registerSchema,
  updateProfileSchema,
  usageQuerySchema,
} from "@/lib/api/schemas";
import { anthropicMessagesSchema, chatCompletionSchema } from "@/lib/gateway/schemas";

describe("self-serve plan changes", () => {
  it("have no schema, so no request body can name a plan", async () => {
    // `changePlanSchema` backed PATCH /api/subscription for the Free/Pro/Business picker. The
    // picker is gone and $0.50 unlimited is the only thing on offer, so the shape that let a
    // caller name their own tier was deleted rather than narrowed.
    const schemas: Record<string, unknown> = await import("@/lib/api/schemas");
    expect("changePlanSchema" in schemas).toBe(false);
  });

  it("have no route handler either — /api/subscription is read-only", () => {
    // Asserted against the source because that is where the capability lives: importing the route
    // would drag in Prisma and auth for a question about which verbs exist. A reintroduced mutator
    // fails here, which is the standing rule "no endpoint may upgrade an account without payment".
    const route = readFileSync(
      fileURLToPath(new URL("../src/app/api/subscription/route.ts", import.meta.url)),
      "utf8",
    );
    expect(route).toMatch(/export const GET\b/);
    for (const verb of ["POST", "PATCH", "PUT", "DELETE"]) {
      expect(route.includes(`export const ${verb}`), verb).toBe(false);
    }
  });
});

describe("adminSubscriptionSchema", () => {
  it("accepts the four plans an operator may assign", () => {
    for (const plan of ["free", "pro", "business", "enterprise"]) {
      expect(adminSubscriptionSchema.safeParse({ plan }).success, plan).toBe(true);
    }
  });

  it("rejects unlimited, so no operator toggle can replace a verified payment", () => {
    expect(adminSubscriptionSchema.safeParse({ plan: "unlimited" }).success).toBe(false);
  });
});

describe("registerSchema", () => {
  it("accepts a well-formed registration", () => {
    const parsed = registerSchema.parse({
      name: "  Ada Lovelace  ",
      email: "  Ada@Example.COM ",
      password: "Correct-Horse-9",
    });
    // Trimmed and lowercased, so "Ada@Example.com" and "ada@example.com" are one account.
    expect(parsed).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.com",
      password: "Correct-Horse-9",
    });
  });

  it("rejects malformed email addresses", () => {
    for (const bad of ["", "ada", "ada@", "@example.com", "ada@example", "a b@example.com"]) {
      expect(registerSchema.safeParse({ name: "A", email: bad, password: "x" }).success, bad).toBe(
        false,
      );
    }
  });

  it("rejects a blank or whitespace-only name", () => {
    for (const name of ["", "   ", "\t"]) {
      expect(registerSchema.safeParse({ name, email: "a@b.co", password: "x" }).success).toBe(false);
    }
  });

  it("does not silently truncate an over-long field", () => {
    const long = "a".repeat(300);
    expect(registerSchema.safeParse({ name: long, email: "a@b.co", password: "x" }).success).toBe(
      false,
    );
    expect(
      registerSchema.safeParse({ name: "A", email: "a@b.co", password: long }).success,
    ).toBe(false);
  });

  it("ignores unknown fields rather than persisting them", () => {
    const parsed = registerSchema.parse({
      name: "A",
      email: "a@b.co",
      password: "x",
      role: "admin", // a privilege-escalation attempt via the request body
    });
    expect(parsed).not.toHaveProperty("role");
  });
});

describe("loginSchema", () => {
  it("normalises the email the same way registration does", () => {
    expect(loginSchema.parse({ email: " A@B.CO ", password: "x" }).email).toBe("a@b.co");
  });

  it("treats remember as optional", () => {
    expect(loginSchema.parse({ email: "a@b.co", password: "x" }).remember).toBeUndefined();
    expect(loginSchema.parse({ email: "a@b.co", password: "x", remember: true }).remember).toBe(
      true,
    );
  });
});

describe("updateProfileSchema", () => {
  it("requires https for an avatar URL", () => {
    expect(updateProfileSchema.safeParse({ avatarUrl: "https://cdn.example/a.png" }).success).toBe(
      true,
    );
    expect(updateProfileSchema.safeParse({ avatarUrl: "" }).success).toBe(true);
    for (const bad of [
      "http://cdn.example/a.png",
      "javascript:alert(1)",
      "data:image/png;base64,AAA",
      "//cdn.example/a.png",
    ]) {
      expect(updateProfileSchema.safeParse({ avatarUrl: bad }).success, bad).toBe(false);
    }
  });

  it("allows a partial update", () => {
    expect(updateProfileSchema.parse({})).toEqual({});
    expect(updateProfileSchema.parse({ name: " Ada " }).name).toBe("Ada");
  });
});

describe("deleteAccountSchema", () => {
  it("demands the literal confirmation string", () => {
    expect(deleteAccountSchema.safeParse({ password: "x", confirm: "DELETE" }).success).toBe(true);
    for (const bad of ["delete", "Delete", "", "DELETE "]) {
      expect(deleteAccountSchema.safeParse({ password: "x", confirm: bad }).success, bad).toBe(
        false,
      );
    }
  });

  /**
   * Which credential is required depends on something the schema cannot see: an account
   * created through Google has `passwordHash = NULL` and proves itself by retyping its email
   * instead. So Zod only checks shapes here, and `deleteAccount` in
   * `src/server/services/auth-service.ts` decides — branching on the *stored* hash, never on
   * which field the client chose to send.
   */
  it("accepts either proof of ownership, leaving the choice to the service", () => {
    expect(deleteAccountSchema.safeParse({ password: "x", confirm: "DELETE" }).success).toBe(true);
    expect(
      deleteAccountSchema.safeParse({ confirmEmail: "a@b.test", confirm: "DELETE" }).success,
    ).toBe(true);
    // Neither one still parses; the service is what refuses it.
    expect(deleteAccountSchema.safeParse({ confirm: "DELETE" }).success).toBe(true);
    // Absurd lengths are rejected before any hashing work happens.
    expect(
      deleteAccountSchema.safeParse({ password: "x".repeat(201), confirm: "DELETE" }).success,
    ).toBe(false);
    expect(
      deleteAccountSchema.safeParse({ confirmEmail: "x".repeat(321), confirm: "DELETE" }).success,
    ).toBe(false);
  });
});

describe("changePasswordSchema", () => {
  it("treats the current password as optional, because a Google-only account has none", () => {
    // `changePassword` requires it whenever `user.passwordHash !== null`; a passwordless
    // account is setting its first password and has nothing to prove here.
    expect(changePasswordSchema.safeParse({ newPassword: "Correct-Horse-9" }).success).toBe(true);
    expect(
      changePasswordSchema.safeParse({ currentPassword: "old", newPassword: "Correct-Horse-9" })
        .success,
    ).toBe(true);
    expect(changePasswordSchema.safeParse({ currentPassword: "old" }).success).toBe(false);
  });
});

describe("createApiKeySchema", () => {
  it("requires a recognisable name", () => {
    expect(createApiKeySchema.parse({ name: "  prod  " }).name).toBe("prod");
    expect(createApiKeySchema.safeParse({ name: "   " }).success).toBe(false);
    expect(createApiKeySchema.safeParse({ name: "a".repeat(81) }).success).toBe(false);
  });
});

describe("usageQuerySchema", () => {
  it("supplies the defaults the usage table renders with", () => {
    expect(usageQuerySchema.parse({})).toMatchObject({
      page: 1,
      pageSize: 25,
      sort: "createdAt",
      direction: "desc",
    });
  });

  it("coerces numeric strings from the query string", () => {
    const parsed = usageQuerySchema.parse({ page: "3", pageSize: "50" });
    expect(parsed.page).toBe(3);
    expect(parsed.pageSize).toBe(50);
  });

  it("rejects a page size outside the allowed band instead of clamping", () => {
    // Clamping would silently disagree with the pagination footer; a 400 is honest.
    expect(usageQuerySchema.safeParse({ pageSize: "5" }).success).toBe(false);
    expect(usageQuerySchema.safeParse({ pageSize: "1000" }).success).toBe(false);
    expect(usageQuerySchema.safeParse({ page: "0" }).success).toBe(false);
    expect(usageQuerySchema.safeParse({ page: "1.5" }).success).toBe(false);
  });

  it("only accepts sortable columns and known statuses", () => {
    expect(usageQuerySchema.safeParse({ sort: "totalTokens" }).success).toBe(true);
    expect(usageQuerySchema.safeParse({ sort: "userId" }).success).toBe(false);
    expect(usageQuerySchema.safeParse({ status: "success" }).success).toBe(true);
    expect(usageQuerySchema.safeParse({ status: "pending" }).success).toBe(false);
    expect(usageQuerySchema.safeParse({ direction: "sideways" }).success).toBe(false);
  });

  it("caps free-text search so a filter cannot become a payload", () => {
    expect(usageQuerySchema.safeParse({ search: "a".repeat(201) }).success).toBe(false);
    expect(usageQuerySchema.parse({ search: "  req_abc  " }).search).toBe("req_abc");
  });
});

/**
 * Runtime-added providers. This body carries a live upstream credential and becomes the prefix
 * of every model id the provider serves, so the slug and the base URL are the two fields worth
 * pinning: a slug outside the safe charset would land in URLs and model ids, and an `http://`
 * base URL would put the credential on the wire in clear text.
 */
describe("adminProviderCreateSchema", () => {
  const valid = {
    provider: "acme",
    label: "Acme Gateway",
    kind: "openai",
    baseUrl: "https://gateway.acme.test/v1",
    apiKey: "sk-acme-0123456789",
  };

  it("accepts a minimal provider and leaves the optional flags for the service to default", () => {
    const parsed = adminProviderCreateSchema.parse(valid);
    expect(parsed).toMatchObject({ provider: "acme", kind: "openai" });
    expect(parsed.enabled).toBeUndefined();
    expect(parsed.syncModels).toBeUndefined();
  });

  it("accepts only the two dialects that have an adapter", () => {
    expect(adminProviderCreateSchema.safeParse({ ...valid, kind: "anthropic" }).success).toBe(true);
    for (const kind of ["google", "gemini", "openai-compatible", ""]) {
      expect(adminProviderCreateSchema.safeParse({ ...valid, kind }).success, kind).toBe(false);
    }
  });

  it("lowercases and trims the slug", () => {
    expect(adminProviderCreateSchema.parse({ ...valid, provider: "  Acme-GW  " }).provider).toBe("acme-gw");
  });

  it("rejects a slug that would be unsafe in a model id or a URL path", () => {
    for (const provider of [
      "a",                      // too short
      "a".repeat(33),           // too long
      "acme gateway",           // space
      "acme_gw",                // underscore
      "-acme",                  // leading dash
      "acme-",                  // trailing dash
      "acme--gw",               // doubled dash
      "acme/gw",                // path separator
      "acmé",                   // non-ascii
    ]) {
      expect(adminProviderCreateSchema.safeParse({ ...valid, provider }).success, provider).toBe(false);
    }
  });

  it("leaves the reserved-id refusal to the service, which knows the builtins", () => {
    // Validation cannot know what this deployment ships; `createCustomProvider` rejects these.
    expect(adminProviderCreateSchema.safeParse({ ...valid, provider: "openai" }).success).toBe(true);
  });
});

describe("adminProviderCreateSchema — base URL", () => {
  const valid = {
    provider: "acme",
    label: "Acme Gateway",
    kind: "openai",
    apiKey: "sk-acme-0123456789",
  };
  const baseUrl = (value: string) => adminProviderCreateSchema.safeParse({ ...valid, baseUrl: value });

  it("strips trailing slashes, because the adapters append their own paths", () => {
    expect(baseUrl("https://gateway.acme.test/v1///").data?.baseUrl).toBe("https://gateway.acme.test/v1");
    expect(baseUrl("  https://gateway.acme.test/v1/  ").data?.baseUrl).toBe("https://gateway.acme.test/v1");
  });

  it("requires https off localhost, since the credential travels in a header", () => {
    expect(baseUrl("http://gateway.acme.test/v1").success).toBe(false);
    expect(baseUrl("https://gateway.acme.test/v1").success).toBe(true);
  });

  it("allows plain http for a loopback upstream only", () => {
    expect(baseUrl("http://localhost:11434/v1").success).toBe(true);
    expect(baseUrl("http://127.0.0.1:8080/v1").success).toBe(true);
    expect(baseUrl("http://[::1]:9000/v1").success).toBe(true);
    // Not loopback, however much it looks like it.
    expect(baseUrl("http://localhost.evil.test/v1").success).toBe(false);
    expect(baseUrl("http://127.0.0.1.evil.test/v1").success).toBe(false);
  });

  it("rejects anything that is not an absolute http(s) URL", () => {
    for (const value of [
      "gateway.acme.test/v1",
      "//gateway.acme.test/v1",
      "ftp://gateway.acme.test/v1",
      "file:///etc/passwd",
      "javascript:alert(1)//aaa",
      "not a url",
    ]) {
      expect(baseUrl(value).success, value).toBe(false);
    }
  });
});

describe("adminProviderCreateSchema — credential and extra headers", () => {
  const valid = {
    provider: "acme",
    label: "Acme Gateway",
    kind: "openai",
    baseUrl: "https://gateway.acme.test/v1",
    apiKey: "sk-acme-0123456789",
  };

  it("bounds the credential length rather than storing anything at all", () => {
    expect(adminProviderCreateSchema.safeParse({ ...valid, apiKey: "short" }).success).toBe(false);
    expect(adminProviderCreateSchema.safeParse({ ...valid, apiKey: "        " }).success).toBe(false);
    expect(adminProviderCreateSchema.safeParse({ ...valid, apiKey: "a".repeat(401) }).success).toBe(false);
    expect(adminProviderCreateSchema.parse({ ...valid, apiKey: "  sk-acme-0123456789  " }).apiKey).toBe(
      "sk-acme-0123456789",
    );
  });

  it("accepts an empty or absent extra-headers value", () => {
    expect(adminProviderCreateSchema.safeParse({ ...valid, extraHeaders: "" }).success).toBe(true);
    expect(adminProviderCreateSchema.safeParse(valid).success).toBe(true);
  });

  it("insists extra headers are a JSON object, so a malformed value is a visible 400", () => {
    expect(adminProviderCreateSchema.safeParse({ ...valid, extraHeaders: '{"x-source":"relayn"}' }).success).toBe(true);
    for (const value of ["{", '["x-source"]', '"relayn"', "42", "null"]) {
      expect(adminProviderCreateSchema.safeParse({ ...valid, extraHeaders: value }).success, value).toBe(false);
    }
  });

  it("does not itself filter protected header names — the registry does", () => {
    // Asserted so the split stays deliberate: accepted here, dropped by `parseExtraHeaders`
    // before any request is made (see tests/provider-registry.test.ts).
    expect(
      adminProviderCreateSchema.safeParse({ ...valid, extraHeaders: '{"authorization":"Bearer x"}' }).success,
    ).toBe(true);
  });
});

describe("adminProviderUpdateSchema", () => {
  it("accepts an empty patch and each field on its own", () => {
    expect(adminProviderUpdateSchema.safeParse({}).success).toBe(true);
    expect(adminProviderUpdateSchema.safeParse({ label: "Renamed" }).success).toBe(true);
    expect(adminProviderUpdateSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(adminProviderUpdateSchema.safeParse({ notes: "" }).success).toBe(true);
  });

  it("omits the credential when the caller does, so a label edit keeps the stored key", () => {
    const parsed = adminProviderUpdateSchema.parse({ label: "Renamed" });
    expect("apiKey" in parsed).toBe(false);
    expect(adminProviderUpdateSchema.parse({ apiKey: "sk-rotated-0123456789" }).apiKey).toBe(
      "sk-rotated-0123456789",
    );
  });

  it("has no slug field, so no request can rename a provider and orphan its models", () => {
    const parsed = adminProviderUpdateSchema.parse({ provider: "other", label: "Renamed" });
    expect("provider" in parsed).toBe(false);
  });

  it("applies the same base-URL and credential rules as creation", () => {
    expect(adminProviderUpdateSchema.safeParse({ baseUrl: "http://gateway.acme.test/v1" }).success).toBe(false);
    expect(adminProviderUpdateSchema.parse({ baseUrl: "https://gateway.acme.test/v1/" }).baseUrl).toBe(
      "https://gateway.acme.test/v1",
    );
    expect(adminProviderUpdateSchema.safeParse({ apiKey: "short" }).success).toBe(false);
  });
});

describe("adminProviderTestSchema", () => {
  it("takes one registry id, so a builtin with no stored row can be probed too", () => {
    expect(adminProviderTestSchema.parse({ provider: "  madefaka  " }).provider).toBe("madefaka");
    expect(adminProviderTestSchema.safeParse({ provider: "" }).success).toBe(false);
    expect(adminProviderTestSchema.safeParse({ provider: "a".repeat(41) }).success).toBe(false);
    expect(adminProviderTestSchema.safeParse({}).success).toBe(false);
  });
});

describe("adminModelSyncSchema", () => {
  it("syncs everything when no providers are named", () => {
    expect(adminModelSyncSchema.parse({}).providers).toBeUndefined();
    expect(adminModelSyncSchema.parse({ providers: [] }).providers).toEqual([]);
  });

  it("bounds the named list", () => {
    expect(adminModelSyncSchema.safeParse({ providers: ["acme", "jerouter"] }).success).toBe(true);
    expect(adminModelSyncSchema.safeParse({ providers: [""] }).success).toBe(false);
    expect(adminModelSyncSchema.safeParse({ providers: Array(21).fill("acme") }).success).toBe(false);
  });
});

describe("chatCompletionSchema", () => {
  const valid = { model: "relayn-sandbox-chat", messages: [{ role: "user", content: "hi" }] };

  it("accepts a minimal OpenAI-shaped body", () => {
    expect(chatCompletionSchema.parse(valid).model).toBe("relayn-sandbox-chat");
  });

  it("requires a model and at least one message", () => {
    expect(chatCompletionSchema.safeParse({ ...valid, model: "" }).success).toBe(false);
    expect(chatCompletionSchema.safeParse({ ...valid, messages: [] }).success).toBe(false);
    expect(chatCompletionSchema.safeParse({ messages: valid.messages }).success).toBe(false);
  });

  it("accepts structured content parts and a null assistant turn", () => {
    expect(
      chatCompletionSchema.safeParse({
        ...valid,
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: [{ type: "text", text: "hi" }] },
          { role: "assistant", content: null },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown role", () => {
    expect(
      chatCompletionSchema.safeParse({ ...valid, messages: [{ role: "root", content: "hi" }] })
        .success,
    ).toBe(false);
  });

  it("bounds the sampling parameters", () => {
    expect(chatCompletionSchema.safeParse({ ...valid, temperature: 2 }).success).toBe(true);
    expect(chatCompletionSchema.safeParse({ ...valid, temperature: 2.1 }).success).toBe(false);
    expect(chatCompletionSchema.safeParse({ ...valid, temperature: -1 }).success).toBe(false);
    expect(chatCompletionSchema.safeParse({ ...valid, top_p: 1.5 }).success).toBe(false);
    expect(chatCompletionSchema.safeParse({ ...valid, max_tokens: 0 }).success).toBe(false);
    expect(chatCompletionSchema.safeParse({ ...valid, max_tokens: 1.5 }).success).toBe(false);
  });

  it("only supports n = 1, rather than accepting a value it would ignore", () => {
    expect(chatCompletionSchema.safeParse({ ...valid, n: 1 }).success).toBe(true);
    expect(chatCompletionSchema.safeParse({ ...valid, n: 4 }).success).toBe(false);
  });

  it("accepts the stream flag and stream_options", () => {
    expect(
      chatCompletionSchema.parse({
        ...valid,
        stream: true,
        stream_options: { include_usage: true },
      }).stream,
    ).toBe(true);
  });
});

describe("anthropicMessagesSchema", () => {
  const valid = {
    model: "relayn-sandbox-chat",
    max_tokens: 512,
    messages: [{ role: "user", content: "hi" }],
  };

  it("requires max_tokens, as the Anthropic API does", () => {
    expect(anthropicMessagesSchema.safeParse(valid).success).toBe(true);
    const { max_tokens: _omitted, ...withoutMaxTokens } = valid;
    expect(anthropicMessagesSchema.safeParse(withoutMaxTokens).success).toBe(false);
  });

  it("allows only user and assistant turns, with system passed separately", () => {
    expect(
      anthropicMessagesSchema.safeParse({
        ...valid,
        messages: [{ role: "system", content: "hi" }],
      }).success,
    ).toBe(false);
    expect(anthropicMessagesSchema.safeParse({ ...valid, system: "be brief" }).success).toBe(true);
  });

  it("caps temperature at 1, matching the Anthropic range rather than OpenAI's", () => {
    expect(anthropicMessagesSchema.safeParse({ ...valid, temperature: 1 }).success).toBe(true);
    expect(anthropicMessagesSchema.safeParse({ ...valid, temperature: 1.5 }).success).toBe(false);
  });
});
