/**
 * What an encrypted value is bound to. The context is authenticated with the value (AES-GCM additional data): a ciphertext copied
 * to another row, another column or another salon fails to decrypt. Every context names the table and column, the salon and the
 * id of the row the value belongs to.
 */
export const aad = {
  phone: (salonId: string, clientId: string): string => `client_pii.phone_enc|${salonId}|${clientId}`,
  name: (salonId: string, clientId: string): string => `client_pii.name_enc|${salonId}|${clientId}`,
  recipient: (salonId: string, outboxId: string): string => `outbox_messages.recipient_enc|${salonId}|${outboxId}`,
  outboxBody: (salonId: string, outboxId: string): string => `outbox_messages.body_enc|${salonId}|${outboxId}`,
  turn: (salonId: string, turnId: string): string => `conversation_turns.body_enc|${salonId}|${turnId}`,
} as const;
