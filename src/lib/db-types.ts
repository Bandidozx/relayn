/**
 * Friendly aliases for the generated Prisma row types.
 *
 * Prisma 7 exports row types as `<Model>Model`; re-exporting them here keeps
 * application code readable and gives one place to adjust if generation changes.
 */
export type {
  UserModel as User,
  SessionModel as Session,
  VerificationTokenModel as VerificationToken,
  ApiKeyModel as ApiKey,
  AiModelModel as AiModel,
  UsageLogModel as UsageLog,
  SubscriptionModel as Subscription,
  PaymentModel as Payment,
  IntegrationModel as Integration,
  SupportTicketModel as SupportTicket,
  TicketMessageModel as TicketMessage,
  AuditLogModel as AuditLog,
  ProviderConfigModel as ProviderConfig,
} from "@/generated/prisma/models";
