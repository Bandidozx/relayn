/**
 * GET  /api/support/tickets — the caller's tickets.
 * POST /api/support/tickets — open a new one.
 */
import { apiRoute, ok, parseJson } from "@/lib/api/http";
import { createTicketSchema } from "@/lib/api/schemas";
import { requireUser } from "@/lib/auth/guards";
import { createTicket, listTickets } from "@/server/services/support-service";

export const GET = apiRoute(async () => {
  const { user } = await requireUser();
  return ok({ tickets: await listTickets(user.id) });
});

export const POST = apiRoute(async (request) => {
  const { user } = await requireUser();
  const body = await parseJson(request, createTicketSchema);
  const ticket = await createTicket(user.id, body, request, user.email);

  return ok({ ticket, tickets: await listTickets(user.id) }, { status: 201 });
});
