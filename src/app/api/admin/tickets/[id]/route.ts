/** PATCH /api/admin/tickets/:id — reply as staff and/or move the ticket's status. */
import { z } from "zod";
import { apiRoute, ok, parseJson } from "@/lib/api/http";
import { requireAdmin } from "@/lib/auth/guards";
import { adminUpdateTicket } from "@/server/services/admin-service";

const patchSchema = z.object({
  status: z.enum(["open", "pending", "resolved", "closed"]).optional(),
  reply: z.string().trim().min(1).max(5000).optional(),
});

export const PATCH = apiRoute<{ id: string }>(async (request, { params }) => {
  const { user } = await requireAdmin();
  const { id } = await params;
  const body = await parseJson(request, patchSchema);

  const tickets = await adminUpdateTicket({ id: user.id, email: user.email }, id, body, request);
  return ok({ tickets });
});
