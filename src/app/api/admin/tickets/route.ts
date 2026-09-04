/** GET /api/admin/tickets — every ticket, newest activity first. */
import { z } from "zod";
import { apiRoute, ok } from "@/lib/api/http";
import { requireAdmin } from "@/lib/auth/guards";
import { listAdminTickets } from "@/server/services/admin-service";

const querySchema = z.object({
  status: z.enum(["open", "pending", "resolved", "closed"]).optional(),
});

export const GET = apiRoute(async (request) => {
  await requireAdmin();
  const { status } = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));

  return ok({ tickets: await listAdminTickets(status) });
});
