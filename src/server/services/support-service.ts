/**
 * Support tickets.
 *
 * `userId` scopes every lookup, including `getTicket`, so ticket ids are not guessable
 * cross-tenant handles. Admin access goes through `admin-service.ts`, which is guarded by
 * `requireAdmin()` separately.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { badRequest, notFound } from "@/lib/api/http";

export interface TicketMessageView {
  id: string;
  authorRole: string;
  body: string;
  createdAt: string;
  mine: boolean;
}

export interface TicketView {
  id: string;
  subject: string;
  category: string;
  priority: string;
  status: string;
  message: string;
  createdAt: string;
  updatedAt: string;
  replyCount: number;
}

export interface TicketDetail extends TicketView {
  messages: TicketMessageView[];
}

const CLOSED = new Set(["resolved", "closed"]);

function toView(row: {
  id: string;
  subject: string;
  category: string;
  priority: string;
  status: string;
  message: string;
  createdAt: Date;
  updatedAt: Date;
  _count?: { messages: number };
}): TicketView {
  return {
    id: row.id,
    subject: row.subject,
    category: row.category,
    priority: row.priority,
    status: row.status,
    message: row.message,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    replyCount: row._count?.messages ?? 0,
  };
}

export async function listTickets(userId: string): Promise<TicketView[]> {
  const rows = await prisma.supportTicket.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { messages: true } } },
  });
  return rows.map(toView);
}

export async function getTicket(userId: string, ticketId: string): Promise<TicketDetail> {
  const row = await prisma.supportTicket.findFirst({
    where: { id: ticketId, userId },
    include: {
      _count: { select: { messages: true } },
      messages: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!row) throw notFound("Ticket not found.");

  return {
    ...toView(row),
    messages: row.messages.map((message) => ({
      id: message.id,
      authorRole: message.authorRole,
      body: message.body,
      createdAt: message.createdAt.toISOString(),
      mine: message.authorId === userId,
    })),
  };
}

export interface CreateTicketInput {
  subject: string;
  category: string;
  priority: string;
  message: string;
}

export async function createTicket(
  userId: string,
  input: CreateTicketInput,
  request: Request,
  actorEmail: string,
): Promise<TicketDetail> {
  const open = await prisma.supportTicket.count({
    where: { userId, status: { in: ["open", "pending"] } },
  });
  if (open >= 10) {
    throw badRequest("You already have 10 open tickets. Close one before opening another.");
  }

  const ticket = await prisma.supportTicket.create({
    data: {
      userId,
      subject: input.subject,
      category: input.category,
      priority: input.priority,
      message: input.message,
    },
  });

  await recordAudit({
    action: "support.ticket_created",
    userId,
    actorEmail,
    targetType: "ticket",
    targetId: ticket.id,
    metadata: { category: input.category, priority: input.priority },
    request,
  });

  return getTicket(userId, ticket.id);
}

export async function replyToTicket(
  userId: string,
  ticketId: string,
  body: string,
): Promise<TicketDetail> {
  const ticket = await prisma.supportTicket.findFirst({ where: { id: ticketId, userId } });
  if (!ticket) throw notFound("Ticket not found.");
  if (CLOSED.has(ticket.status)) throw badRequest("This ticket is closed. Open a new one instead.");

  await prisma.$transaction([
    prisma.ticketMessage.create({
      data: { ticketId, authorId: userId, authorRole: "user", body },
    }),
    prisma.supportTicket.update({ where: { id: ticketId }, data: { status: "open" } }),
  ]);

  return getTicket(userId, ticketId);
}

export async function setTicketStatus(
  userId: string,
  ticketId: string,
  status: string,
  request: Request,
  actorEmail: string,
): Promise<TicketDetail> {
  // Users may only close their own tickets; moving one back to "pending" is an admin action.
  if (status !== "closed" && status !== "open") {
    throw badRequest("You can reopen or close a ticket.");
  }

  const result = await prisma.supportTicket.updateMany({
    where: { id: ticketId, userId },
    data: { status },
  });
  if (result.count === 0) throw notFound("Ticket not found.");

  await recordAudit({
    action: "support.ticket_updated",
    userId,
    actorEmail,
    targetType: "ticket",
    targetId: ticketId,
    metadata: { status },
    request,
  });

  return getTicket(userId, ticketId);
}
