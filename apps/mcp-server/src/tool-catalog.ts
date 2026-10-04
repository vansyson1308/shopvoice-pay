// Every MCP tool ShopVoice registers, in listing order.
import { getLowStock, getStockLevel, getSalesSummary, getTopMovers, getInvoiceStatus, suggestReorder, createReorderDraft, getDailyBriefing } from './tools.js';
import { PAYMENT_TOOLS } from './payment-tools.js';

export const ALL_TOOLS = [
  getLowStock, getStockLevel, getSalesSummary, getTopMovers, getInvoiceStatus,
  suggestReorder, createReorderDraft, ...PAYMENT_TOOLS, getDailyBriefing
] as const;
