export interface CanonicalInvoiceItem {
  readonly line_no: number;
  readonly sku?: string;
  readonly product_name: string;
  readonly quantity: number;
  readonly unit_price: number;
  readonly line_total: number;
  readonly uom?: string;
}

export interface CanonicalInvoice {
  readonly supplier_code?: string;
  readonly invoice_number: string;
  readonly invoice_date: string;
  readonly currency: string;
  readonly subtotal: number;
  readonly tax_total: number;
  readonly total: number;
  readonly items: readonly CanonicalInvoiceItem[];
}

const MAX_XML_BYTES = 1024 * 1024;
const MAX_TAG_VALUE_LEN = 4096;
const MAX_ITEM_COUNT = 1000;

function enforceXmlBounds(xml: string) {
  if (xml.length > MAX_XML_BYTES) {
    throw new Error('xml_too_large');
  }
}

function readTagValue(xml: string, tag: string, fromIndex = 0): { value: string | null; endIndex: number } {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = xml.indexOf(open, fromIndex);
  if (start === -1) return { value: null, endIndex: -1 };

  const valueStart = start + open.length;
  const end = xml.indexOf(close, valueStart);
  if (end === -1) return { value: null, endIndex: -1 };

  const raw = xml.slice(valueStart, end);
  if (raw.length > MAX_TAG_VALUE_LEN) {
    throw new Error('xml_tag_value_too_large');
  }

  return { value: raw.trim(), endIndex: end + close.length };
}

function collectTagBlocks(xml: string, tag: string): string[] {
  const blocks = [];
  const open = `<${tag}>`;
  const close = `</${tag}>`;

  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf(open, cursor);
    if (start === -1) break;

    const blockStart = start + open.length;
    const end = xml.indexOf(close, blockStart);
    if (end === -1) {
      throw new Error('invalid_xml_structure');
    }

    const block = xml.slice(blockStart, end);
    if (block.length > MAX_TAG_VALUE_LEN * 8) {
      throw new Error('xml_item_too_large');
    }

    blocks.push(block);
    if (blocks.length > MAX_ITEM_COUNT) {
      throw new Error('too_many_items');
    }

    cursor = end + close.length;
  }

  return blocks;
}

function parseNumber(input: string | null, fallback = 0): number {
  if (!input) return fallback;
  if (input.length > 64) throw new Error('invalid_number');
  const n = Number(input);
  if (!Number.isFinite(n)) throw new Error('invalid_number');
  return n;
}

function tagOnly(xml: string, tag: string): string | null {
  return readTagValue(xml, tag).value;
}

export function parseInvoiceXml(xml: string): CanonicalInvoice {
  enforceXmlBounds(xml);

  if (xml.includes('<!DOCTYPE') || xml.includes('<!ENTITY') || xml.includes('<!doctype') || xml.includes('<!entity')) {
    throw new Error('xxe_disallowed');
  }

  const invoiceNumber = tagOnly(xml, 'invoiceNumber');
  const invoiceDate = tagOnly(xml, 'invoiceDate');
  const currency = tagOnly(xml, 'currency') ?? 'VND';
  const supplierCode = tagOnly(xml, 'supplierCode');

  if (!invoiceNumber || !invoiceDate) {
    throw new Error('invalid_invoice_header');
  }

  const itemBlocks = collectTagBlocks(xml, 'item');
  if (itemBlocks.length === 0) {
    throw new Error('missing_items');
  }

  const items = itemBlocks.map((itemXml, i) => {
    const productName = tagOnly(itemXml, 'name');
    if (!productName) throw new Error('invalid_item');

    const quantity = parseNumber(tagOnly(itemXml, 'qty'));
    const unitPrice = parseNumber(tagOnly(itemXml, 'unitPrice'));
    const lineTotal = parseNumber(tagOnly(itemXml, 'lineTotal'), quantity * unitPrice);

    const sku = tagOnly(itemXml, 'sku') ?? null;
    const uom = tagOnly(itemXml, 'uom') ?? null;
    return {
      line_no: i + 1,
      ...(sku ? { sku } : {}),
      product_name: productName,
      quantity,
      unit_price: unitPrice,
      line_total: lineTotal,
      ...(uom ? { uom } : {})
    };
  });

  const subtotal = parseNumber(tagOnly(xml, 'subtotal'), items.reduce((sum, x) => sum + x.line_total, 0));
  const taxTotal = parseNumber(tagOnly(xml, 'taxTotal'), 0);
  const total = parseNumber(tagOnly(xml, 'total'), subtotal + taxTotal);

  return {
    ...(supplierCode ? { supplier_code: supplierCode } : {}),
    invoice_number: invoiceNumber,
    invoice_date: invoiceDate,
    currency,
    subtotal,
    tax_total: taxTotal,
    total,
    items
  };
}
