// Chat rendering of tool results. Voice clients (the Alexa simulator) read
// the <= 35-word spoken sentence; chat clients such as Claude get a compact
// markdown summary instead. structuredContent is identical for both.

type Data = Record<string, unknown>;
type Row = Record<string, unknown>;

const MAX_ROWS = 20;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const rows = (v: unknown): Row[] => (Array.isArray(v) ? (v as Row[]) : []);

function cell(v: unknown): string {
  return str(v).replace(/\|/g, '/').replace(/\s+/g, ' ').trim() || '–';
}

/** Display-currency amount: "$1,234.50", "12.30 EUR". */
export function money(amount: unknown, currency: string): string {
  const n = num(amount);
  const fixed = n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (currency === 'USD') return `$${fixed}`;
  if (currency === 'EUR') return `€${fixed}`;
  return `${fixed} ${currency}`;
}

function qty(v: unknown, unit: unknown): string {
  const n = num(v);
  const text = Number.isInteger(n) ? String(n) : n.toFixed(1);
  return unit ? `${text} ${str(unit)}` : text;
}

function days(v: unknown): string {
  if (v === null || v === undefined) return 'no recent sales';
  const n = num(v);
  if (n < 1) return 'under 1 day';
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} days`;
}

function pct(v: unknown): string {
  if (v === null || v === undefined) return 'n/a';
  const n = num(v);
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function table(headers: string[], body: string[][], total: number): string {
  const lines = [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`];
  for (const r of body.slice(0, MAX_ROWS)) lines.push(`| ${r.map(cell).join(' | ')} |`);
  if (total > MAX_ROWS) lines.push(`\n_…and ${total - MAX_ROWS} more (see structuredContent)._`);
  return lines.join('\n');
}

function period(p: unknown): string {
  const o = (p ?? {}) as Row;
  const range = o.start === o.end ? str(o.start) : `${str(o.start)} to ${str(o.end)}`;
  return `${str(o.label) || 'period'} (${range}${o.partial === true ? ', so far' : ''})`;
}

const INVOICE_STATUS: Record<string, string> = {
  arrived: 'Arrived, not matched yet',
  mapped: 'Matched, not posted to inventory',
  synced: 'Posted to inventory'
};

const RENDERERS: Record<string, (d: Data, c: string) => string> = {
  get_low_stock(d) {
    const items = rows(d.items);
    if (num(d.total_low) === 0) return 'Nothing is below its minimum stock level right now.';
    return `**${num(d.total_low)} product(s) at or below minimum stock**, most urgent first:\n\n${table(
      ['Product', 'On hand', 'Minimum', 'Days of cover', 'Supplier'],
      items.map((i) => [str(i.name), qty(i.on_hand, i.unit), qty(i.min_qty, i.unit), days(i.days_of_cover), str(i.supplier_code)]),
      num(d.total_low)
    )}`;
  },
  get_stock_level(d) {
    if (d.status === 'found') {
      const p = (d.product ?? {}) as Row;
      return `**${str(p.name)}**: ${qty(p.on_hand, p.unit)} on hand (minimum ${qty(p.min_qty, p.unit)}), about ${days(p.days_of_cover)} of cover at ${num(p.avg_daily_sales).toFixed(1)} sold per day${p.below_min === true ? ' — **below minimum**' : ''}.`;
    }
    const names = rows(d.candidates).map((c) => `${str(c.name)} (\`${str(c.sku)}\`)`).join(', ');
    return d.status === 'ambiguous'
      ? `Several products match "${str(d.query)}": ${names}. Ask again with one of these names or SKUs.`
      : `No product matches "${str(d.query)}".${names ? ` Closest: ${names}.` : ''}`;
  },
  get_sales_summary(d, c) {
    const lines = [`**Sales, ${period(d.period)}**: ${money(d.revenue, c)} from ${qty(d.units, null)} units.`];
    const cmp = d.comparison as Row | null;
    if (cmp) lines.push(`Compared with ${period(cmp.period)}: ${money(cmp.revenue, c)} from ${qty(cmp.units, null)} units (${pct(cmp.change_pct)}).`);
    return lines.join('\n');
  },
  get_top_movers(d, c) {
    const items = rows(d.items);
    const head = `**${d.direction === 'bottom' ? 'Slowest' : 'Top'} ${items.length} products by ${str(d.metric)}, ${period(d.period)}**`;
    return `${head}\n\n${table(['#', 'Product', 'Units', 'Revenue'], items.map((i) => [str(i.rank), str(i.name), qty(i.units, i.unit), money(i.revenue, c)]), items.length)}`;
  },
  get_invoice_status(d, c) {
    const inv = rows(d.invoices);
    if (inv.length === 0) return d.query ? `No recent supplier invoice matches "${str(d.query)}".` : 'No supplier invoices yet.';
    const head = d.query ? `**Supplier invoices matching "${str(d.query)}"**` : '**Latest supplier invoices**';
    return `${head}\n\n${table(['Invoice', 'Supplier', 'Date', 'Total', 'Lines', 'Status'], inv.map((i) => [
      str(i.invoice_number), str(i.supplier_name ?? i.supplier_code), str(i.invoice_date), money(i.total, c),
      `${num(i.line_count)}${num(i.unmatched_lines) ? ` (${num(i.unmatched_lines)} unmatched)` : ''}`, INVOICE_STATUS[str(i.status)] ?? str(i.status)
    ]), inv.length)}`;
  },
  suggest_reorder(d, c) {
    const sup = rows(d.suppliers);
    if (sup.length === 0) return 'Nothing needs reordering right now.';
    const parts = [`**Suggested reorder: ${num(d.item_count)} item(s), about ${money(d.total, c)}** (suggestion only, nothing is ordered).`];
    for (const s of sup) {
      const lines = rows(s.lines);
      parts.push(`\n**${str(s.supplier_name)}** (lead time ${num(s.lead_time_days)} day(s), about ${money(s.total, c)})\n\n${table(
        ['Product', 'On hand', 'Days of cover', 'Order'],
        lines.map((l) => [str(l.name), qty(l.on_hand, l.unit), days(l.days_of_cover), qty(l.suggested_qty, l.unit)]),
        lines.length
      )}`);
    }
    return parts.join('\n');
  },
  create_reorder_draft(d, c) {
    if (d.status === 'nothing_to_order') return 'Nothing needs reordering right now, so no draft was created.';
    if (d.status === 'needs_clarification') {
      const qs = rows(d.clarifications).map((q) => `- "${str(q.query)}": ${q.status === 'ambiguous' ? 'several matches' : 'no match'}${rows(q.candidates).length ? ` (${rows(q.candidates).map((x) => str(x.name)).join(', ')})` : ''}`);
      return `No draft created yet. These items need a clearer product name:\n${qs.join('\n')}`;
    }
    const parts = [`**Purchase-order draft(s) created, total about ${money(d.total, c)}.** Not placed yet: nothing is ordered until confirm_reorder runs with the confirmation token below (valid ${Math.round(num(d.expires_in_seconds) / 60)} minutes, one use).`];
    for (const dr of rows(d.drafts)) {
      const lines = rows(dr.lines);
      parts.push(`\n**${str(dr.supplier_name)}**, about ${money(dr.total, c)}\n\n${table(['Product', 'Quantity'], lines.map((l) => [str(l.name), qty(l.qty, l.unit)]), lines.length)}`);
    }
    parts.push(`\nconfirmation_token: \`${str(d.confirmation_token)}\` (expires ${str(d.expires_at)})`);
    return parts.join('\n');
  },
  confirm_reorder(d, c) {
    const list = rows(d.drafts).map((x) => `- ${str(x.supplier_name)}: ${money(x.total, c)} (${str(x.status)})`).join('\n');
    switch (d.status) {
      case 'confirmed':
        return `**Confirmed ${num(d.confirmed_count)} purchase order(s), total ${money(d.total, c)}.** They are recorded in the shop's purchase orders; no payment was made.\n${list}`;
      case 'already_confirmed':
        return `These orders were already confirmed; nothing changed.\n${list}`;
      case 'expired':
        return 'That draft expired (drafts are valid for 5 minutes), so nothing was ordered. Create a new draft with create_reorder_draft.';
      default:
        return 'No draft matches that confirmation token. Create a new draft with create_reorder_draft.';
    }
  },
  get_daily_briefing(d, c) {
    return [
      '**Daily shop briefing**',
      `- Yesterday's sales: ${money(d.yesterday_revenue, c)} (${pct(d.yesterday_change_pct)} vs the same weekday last week)`,
      `- Products at or below minimum stock: ${num(d.low_stock_count)}${d.most_urgent ? ` (most urgent: ${str(d.most_urgent)})` : ''}`,
      `- Supplier invoices not yet synced to the POS: ${num(d.invoices_pending_sync)}`
    ].join('\n');
  }
};

export function toMarkdown(toolName: string, data: unknown, fallback: string): string {
  const render = RENDERERS[toolName];
  if (!render || !data || typeof data !== 'object') return fallback;
  const d = data as Data;
  return render(d, str(d.currency) || 'USD');
}
