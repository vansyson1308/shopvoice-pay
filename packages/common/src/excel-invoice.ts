import type { CanonicalInvoice, CanonicalInvoiceItem } from './xml-invoice.js';

export type { CanonicalInvoice, CanonicalInvoiceItem };

const MAX_EXCEL_BYTES = 10 * 1024 * 1024;
const MAX_ROW_COUNT = 1000;
const MAX_SHEET_COUNT = 10;

interface ColumnMap {
  product_name: number;
  quantity: number;
  unit_price: number;
  line_total: number;
  uom?: number;
  sku?: number;
}

const HEADER_PATTERNS: Record<keyof ColumnMap, RegExp[]> = {
  product_name: [
    /^t[eê]n\s*h[aà]ng\s*h[oó]a/i,
    /^t[eê]n\s*(sp|s[aả]n\s*ph[aẩ]m)/i,
    /^(s[aả]n\s*ph[aẩ]m|h[aà]ng\s*h[oó]a)/i,
    /^product[\s_]*name/i,
    /^(m[oô]\s*t[aả]|di[eễ]n\s*gi[aả]i)/i,
    /^t[eê]n$/i,
    /^name$/i,
  ],
  quantity: [
    /^(sl|s[oố]\s*l[uư][oợ]ng)/i,
    /^qty/i,
    /^quantity/i,
  ],
  unit_price: [
    /^([dđ][oơ]n\s*gi[aá])/i,
    /^gi[aá]$/i,
    /^unit[\s_]*price/i,
    /^price/i,
  ],
  line_total: [
    /^th[aà]nh\s*ti[eề]n/i,
    /^t[oổ]ng(\s*ti[eề]n)?$/i,
    /^(line[\s_]*total|amount|total)/i,
  ],
  uom: [
    /^[dđ][oơ]n\s*v[iị](\s*t[ií]nh)?/i,
    /^dvt$/i,
    /^(unit|uom)$/i,
  ],
  sku: [
    /^m[aã]\s*(h[aà]ng|sp|s[aả]n\s*ph[aẩ]m)/i,
    /^(sku|code)$/i,
    /^m[aã]$/i,
  ],
};

function matchHeader(cellValue: unknown, patterns: RegExp[]): boolean {
  if (cellValue == null) return false;
  const text = String(cellValue).trim();
  if (text.length === 0 || text.length > 100) return false;
  return patterns.some((p) => p.test(text));
}

function detectColumns(headerRow: unknown[]): ColumnMap | null {
  const map: Partial<ColumnMap> = {};

  for (let col = 0; col < headerRow.length; col++) {
    const cell = headerRow[col];
    for (const [field, patterns] of Object.entries(HEADER_PATTERNS) as [keyof ColumnMap, RegExp[]][]) {
      if (map[field] === undefined && matchHeader(cell, patterns)) {
        map[field] = col;
        break;
      }
    }
  }

  if (map.product_name === undefined || map.quantity === undefined) {
    return null;
  }

  return {
    product_name: map.product_name,
    quantity: map.quantity,
    unit_price: map.unit_price ?? -1,
    line_total: map.line_total ?? -1,
    ...(map.uom !== undefined ? { uom: map.uom } : {}),
    ...(map.sku !== undefined ? { sku: map.sku } : {}),
  };
}

function cellToNumber(cell: unknown): number {
  if (cell == null) return 0;
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : 0;
  let s = String(cell).trim();
  if (s.length === 0) return 0;
  // Vietnamese format: "." = thousands separator, "," = decimal
  // Detect: if string has dots and every dot-separated group (except first) has 3 digits → Vietnamese thousands
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  if (hasDot && !hasComma) {
    const parts = s.split('.');
    const isThousands = parts.length > 1 && parts.slice(1).every((p) => /^\d{3}$/.test(p));
    if (isThousands) {
      s = parts.join('');
    }
  } else if (hasDot && hasComma) {
    // "33.334,50" → Vietnamese: dot=thousands, comma=decimal
    const dotIdx = s.indexOf('.');
    const commaIdx = s.indexOf(',');
    if (dotIdx < commaIdx) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (hasComma && !hasDot) {
    s = s.replace(/,/g, '');
  }
  s = s.replace(/\s/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function cellToString(cell: unknown): string {
  if (cell == null) return '';
  if (typeof cell === 'object' && 'text' in (cell as Record<string, unknown>)) {
    return String((cell as Record<string, unknown>).text ?? '').trim();
  }
  if (typeof cell === 'object' && 'result' in (cell as Record<string, unknown>)) {
    return String((cell as Record<string, unknown>).result ?? '').trim();
  }
  return String(cell).trim();
}

export async function parseExcelInvoice(buffer: Buffer): Promise<CanonicalInvoice> {
  if (buffer.length > MAX_EXCEL_BYTES) {
    throw new Error('excel_too_large');
  }
  if (buffer.length === 0) {
    throw new Error('excel_empty');
  }

  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.default.Workbook();

  try {
    await workbook.xlsx.load(buffer as never);
  } catch {
    throw new Error('excel_invalid_format');
  }

  if (workbook.worksheets.length === 0) {
    throw new Error('excel_no_sheets');
  }
  if (workbook.worksheets.length > MAX_SHEET_COUNT) {
    throw new Error('excel_too_many_sheets');
  }

  const sheet = workbook.worksheets[0]!;
  const rowCount = sheet.rowCount;

  if (rowCount < 2) {
    throw new Error('excel_no_data');
  }

  let columns: ColumnMap | null = null;
  let headerRowIndex = -1;

  for (let r = 1; r <= Math.min(rowCount, 20); r++) {
    const row = sheet.getRow(r);
    const values: unknown[] = [];
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      values[colNumber - 1] = cell.value;
    });

    const detected = detectColumns(values);
    if (detected) {
      columns = detected;
      headerRowIndex = r;
      break;
    }
  }

  if (!columns || headerRowIndex === -1) {
    throw new Error('excel_header_not_found');
  }

  const items: CanonicalInvoiceItem[] = [];

  for (let r = headerRowIndex + 1; r <= rowCount; r++) {
    if (items.length >= MAX_ROW_COUNT) {
      throw new Error('excel_too_many_rows');
    }

    const row = sheet.getRow(r);
    const values: unknown[] = [];
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      values[colNumber - 1] = cell.value;
    });

    const productName = cellToString(values[columns.product_name]);
    if (productName.length === 0) continue;

    const quantity = cellToNumber(values[columns.quantity]);
    const unitPrice = columns.unit_price >= 0 ? cellToNumber(values[columns.unit_price]) : 0;
    const lineTotal = columns.line_total >= 0
      ? cellToNumber(values[columns.line_total])
      : quantity * unitPrice;

    const uom = columns.uom !== undefined ? cellToString(values[columns.uom]) : undefined;
    const sku = columns.sku !== undefined ? cellToString(values[columns.sku]) : undefined;

    items.push({
      line_no: items.length + 1,
      product_name: productName,
      quantity,
      unit_price: unitPrice,
      line_total: lineTotal,
      ...(uom ? { uom } : {}),
      ...(sku ? { sku } : {}),
    });
  }

  if (items.length === 0) {
    throw new Error('excel_no_items');
  }

  const subtotal = items.reduce((sum, x) => sum + x.line_total, 0);

  return {
    invoice_number: `EXCEL-${Date.now()}`,
    invoice_date: new Date().toISOString().slice(0, 10),
    currency: 'VND',
    subtotal,
    tax_total: 0,
    total: subtotal,
    items,
  };
}
