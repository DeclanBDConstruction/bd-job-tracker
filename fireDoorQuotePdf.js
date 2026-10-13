// Fire Door Quote PDF: generated on demand from a saved fire_door_quotes row - the ticked
// items are already snapshotted with name/price/quantity at save time (see
// createFireDoorQuote in db.js), so this just lays them out as a table with VAT and a grand
// total. Modelled on the company's real "Quotes Example.xlsx" estimate template (letterhead,
// FTAO client block, description, itemized costs, VAT @ 20%, disclaimer note), using the
// same pdf-lib module shape as permitPdf.js/cadPdf.js (one exported async function returning
// a Buffer via pdfDoc.save()).

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const COMPANY_NAME = 'BD Construction Limited';
const COMPANY_ADDRESS_LINES = ['Unit 1 Harvey Court', 'Harvey Lane, Golborne, WA3 3RX'];
const COMPANY_PHONE = '01942 725548';
const COMPANY_EMAIL = 'Info@bdconstruction.co.uk';

// Verbatim from the company's own estimate template, so every generated quote carries the
// same disclaimer their real quotes always have.
const DISCLAIMER = 'Note:- This is not a contract or a bill. It is our best estimate at the total price to '
  + 'complete the works stated above, based on our initial survey. If any additional works and labour are '
  + 'required we will inform you and send an update in costs.';

const BLUE_DARK = rgb(0.07, 0.31, 0.47);
const GREY = rgb(0.45, 0.45, 0.45);
const LINE_GREY = rgb(0.82, 0.82, 0.82);
const TEXT_DARK = rgb(0.13, 0.13, 0.13);

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89; // A4
const MARGIN_X = 50;
const FIELD_WIDTH = 495.28;
const TOP_Y = 791;
const BOTTOM_Y = 60;

const COL_ITEM = MARGIN_X;
const COL_ITEM_WIDTH = 300;
const COL_QTY_RIGHT = MARGIN_X + 350;
const COL_UNIT_RIGHT = MARGIN_X + 430;
const COL_TOTAL_RIGHT = MARGIN_X + FIELD_WIDTH;

function money(n) {
  return '£' + (Number(n) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Short, stable reference the client can quote back - not a sequential invoice number (the
// app has no counter for that), just the quote's own id made readable.
function estimateNumber(quote) {
  return 'FD-' + quote.id.replace(/-/g, '').slice(0, 8).toUpperCase();
}

// Greedy word-wrap so long item names/notes don't run off the page edge - same helper as
// permitPdf.js.
function wrapText(text, font, size, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let current = words[0];
  for (const word of words.slice(1)) {
    const candidate = `${current} ${word}`;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) current = candidate;
    else { lines.push(current); current = word; }
  }
  lines.push(current);
  return lines;
}

async function generateFireDoorQuotePdf(quote) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const italicFont = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = TOP_Y;

  function newPage() {
    page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = TOP_Y;
  }

  function drawRight(text, rightX, size, f, color) {
    const w = f.widthOfTextAtSize(text, size);
    page.drawText(text, { x: rightX - w, y, size, font: f, color });
  }

  // Letterhead: company details on the left, "WORK ESTIMATE" + reference/date on the right,
  // matching the layout of the real spreadsheet template.
  const headerTopY = y;
  page.drawText(COMPANY_NAME, { x: MARGIN_X, y, size: 16, font: boldFont, color: BLUE_DARK });
  y -= 16;
  for (const line of COMPANY_ADDRESS_LINES) {
    page.drawText(line, { x: MARGIN_X, y, size: 9, font, color: GREY });
    y -= 12;
  }
  page.drawText(`${COMPANY_PHONE}  |  ${COMPANY_EMAIL}`, { x: MARGIN_X, y, size: 9, font, color: GREY });

  y = headerTopY;
  drawRight('WORK ESTIMATE', COL_TOTAL_RIGHT, 16, boldFont, TEXT_DARK);
  y -= 18;
  drawRight(`Estimate #: ${estimateNumber(quote)}`, COL_TOTAL_RIGHT, 10, font, GREY);
  y -= 14;
  drawRight(`Date: ${new Date(quote.createdAt).toLocaleDateString('en-GB')}`, COL_TOTAL_RIGHT, 10, font, GREY);

  y = headerTopY - 48;
  page.drawLine({ start: { x: MARGIN_X, y }, end: { x: MARGIN_X + FIELD_WIDTH, y }, thickness: 1, color: LINE_GREY });
  y -= 24;

  // FTAO (For The Attention Of) client block.
  page.drawText('FTAO', { x: MARGIN_X, y, size: 10, font: boldFont, color: GREY });
  y -= 15;
  page.drawText(quote.clientName, { x: MARGIN_X, y, size: 13, font: boldFont, color: TEXT_DARK });
  y -= 18;
  if (quote.siteAddress) {
    for (const line of wrapText(quote.siteAddress, font, 11, FIELD_WIDTH)) {
      page.drawText(line, { x: MARGIN_X, y, size: 11, font, color: TEXT_DARK });
      y -= 15;
    }
  }
  y -= 10;

  // Description of works - the auto-generated (or hand-written) summary of what's being
  // quoted for, equivalent to the "Title" line on the real template.
  page.drawText('Description of Works', { x: MARGIN_X, y, size: 10, font: boldFont, color: GREY });
  y -= 15;
  for (const line of wrapText(quote.notes || 'Fire door works as specified.', font, 12, FIELD_WIDTH)) {
    page.drawText(line, { x: MARGIN_X, y, size: 12, font, color: TEXT_DARK });
    y -= 16;
  }

  y -= 10;
  page.drawLine({ start: { x: MARGIN_X, y }, end: { x: MARGIN_X + FIELD_WIDTH, y }, thickness: 1, color: LINE_GREY });
  y -= 22;

  function drawTableHeader() {
    page.drawText('Item', { x: COL_ITEM, y, size: 10, font: boldFont, color: GREY });
    drawRight('Qty', COL_QTY_RIGHT, 10, boldFont, GREY);
    drawRight('Unit Price', COL_UNIT_RIGHT, 10, boldFont, GREY);
    drawRight('Amount', COL_TOTAL_RIGHT, 10, boldFont, GREY);
    y -= 8;
    page.drawLine({ start: { x: MARGIN_X, y }, end: { x: MARGIN_X + FIELD_WIDTH, y }, thickness: 1, color: LINE_GREY });
    y -= 18;
  }

  drawTableHeader();

  function ensureRowSpace(linesNeeded) {
    if (y - linesNeeded * 14 < BOTTOM_Y) {
      newPage();
      drawTableHeader();
    }
  }

  for (const it of quote.items) {
    const lines = wrapText(it.name, font, 11, COL_ITEM_WIDTH);
    ensureRowSpace(lines.length + 1);
    const rowTopY = y;
    for (const line of lines) {
      page.drawText(line, { x: COL_ITEM, y, size: 11, font, color: TEXT_DARK });
      y -= 14;
    }
    const savedY = y;
    y = rowTopY;
    drawRight(String(it.quantity), COL_QTY_RIGHT, 11, font, TEXT_DARK);
    drawRight(money(it.price), COL_UNIT_RIGHT, 11, font, TEXT_DARK);
    drawRight(money(it.price * it.quantity), COL_TOTAL_RIGHT, 11, boldFont, TEXT_DARK);
    y = savedY - 6;
  }

  ensureRowSpace(7);
  y -= 6;
  page.drawLine({ start: { x: MARGIN_X, y }, end: { x: MARGIN_X + FIELD_WIDTH, y }, thickness: 1, color: LINE_GREY });
  y -= 20;

  page.drawText('Estimate Total', { x: COL_UNIT_RIGHT - 120, y, size: 11, font, color: TEXT_DARK });
  drawRight(money(quote.subtotal), COL_TOTAL_RIGHT, 11, font, TEXT_DARK);
  y -= 16;
  page.drawText('VAT @ 20%', { x: COL_UNIT_RIGHT - 120, y, size: 11, font, color: TEXT_DARK });
  drawRight(money(quote.vat), COL_TOTAL_RIGHT, 11, font, TEXT_DARK);
  y -= 18;
  page.drawLine({ start: { x: COL_UNIT_RIGHT - 120, y }, end: { x: MARGIN_X + FIELD_WIDTH, y }, thickness: 1, color: LINE_GREY });
  y -= 18;
  page.drawText('Total', { x: COL_UNIT_RIGHT - 120, y, size: 13, font: boldFont, color: TEXT_DARK });
  drawRight(money(quote.total), COL_TOTAL_RIGHT, 13, boldFont, BLUE_DARK);

  y -= 34;
  ensureRowSpace(6);
  page.drawText('Thank you for your business!', { x: MARGIN_X, y, size: 11, font: italicFont, color: TEXT_DARK });
  y -= 22;

  for (const line of wrapText(DISCLAIMER, font, 8, FIELD_WIDTH)) {
    page.drawText(line, { x: MARGIN_X, y, size: 8, font, color: GREY });
    y -= 11;
  }

  y -= 20;
  page.drawText('Kind Regards,', { x: MARGIN_X, y, size: 11, font, color: TEXT_DARK });
  y -= 15;
  page.drawText(COMPANY_NAME, { x: MARGIN_X, y, size: 11, font: boldFont, color: BLUE_DARK });
  y -= 14;
  page.drawText(`${COMPANY_PHONE}  |  ${COMPANY_EMAIL}`, { x: MARGIN_X, y, size: 9, font, color: GREY });

  return Buffer.from(await pdfDoc.save());
}

module.exports = { generateFireDoorQuotePdf };
