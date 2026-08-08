import { requireRequestContext } from "@/lib/context";
import { apiRoute, jsonOk } from "@/lib/http";
import { getTicket } from "@/lib/services/tickets";
import { parseIdParam } from "@/lib/validation/parse";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * ORD-04: reads a ticket and its lines. This is what makes "fermer, changer
 * de route ou rafraîchir ne perd aucun article" true — the drawer's contents
 * are fetched, never restored from anything the browser was holding.
 */
export const GET = apiRoute<RouteParams>(async (_request, { params }) => {
  const context = await requireRequestContext();
  const { id } = await params;
  const ticket = await getTicket(context, parseIdParam(id, "Identifiant ticket"));
  return jsonOk(ticket);
});
