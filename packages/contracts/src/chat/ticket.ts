import { z } from "zod";

export const chatWsTicketSchema = z.object({
  ticket: z.string().min(1),
  wsUrl: z.string().min(1),
  expiresAt: z.string().min(1),
});
export type ChatWsTicket = z.infer<typeof chatWsTicketSchema>;
