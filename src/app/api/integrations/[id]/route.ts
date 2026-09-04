/** DELETE /api/integrations/:id — remove a saved integration (owner only). */
import { apiRoute, ok } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/guards";
import { deleteIntegration } from "@/server/services/integrations-service";

export const DELETE = apiRoute<{ id: string }>(async (request, { params }) => {
  const { user } = await requireUser();
  const { id } = await params;

  return ok({ integrations: await deleteIntegration(user.id, id, request, user.email) });
});
