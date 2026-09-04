/**
 * GET   /api/support/tickets/:id — thread detail (scoped to the owner).
 * POST  /api/support/tickets/:id — post a reply.
 * PATCH /api/support/tickets/:id — reopen or close.
 */
import { apiRoute, ok, parseJson } from "@/lib/api/http";
import { closeTicketSchema, ticketReplySchema } from "@/lib/api/schemas";
import { requireUser } from "@/lib/auth/guards";
import { getTicket, replyToTicket, setTicketStatus } from "@/server/services/support-service";

interface Params {
  id: string;
}

export const GET = apiRoute<Params>(async (_request, { params }) => {
  const { user } = await requireUser();
  const { id } = await params;
  return ok({ ticket: await getTicket(user.id, id) });
});

export const POST = apiRoute<Params>(async (request, { params }) => {
  const { user } = await requireUser();
  const { id } = await params;
  const body = await parseJson(request, ticketReplySchema);

  return ok({ ticket: await replyToTicket(user.id, id, body.message) });
});

export const PATCH = apiRoute<Params>(async (request, { params }) => {
  const { user } = await requireUser();
  const { id } = await params;
  const body = await parseJson(request, closeTicketSchema);

  return ok({ ticket: await setTicketStatus(user.id, id, body.status, request, user.email) });
});
