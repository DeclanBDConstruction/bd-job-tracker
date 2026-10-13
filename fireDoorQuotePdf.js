// Fire Door Quote PDF: generated on demand from a saved fire_door_quotes row - the ticked
// items are already snapshotted with name/price/quantity at save time (see
// createFireDoorQuote in db.js), so this just lays them out as a table with a grand total.
// Same pdf-lib module shape as permitPdf.js/cadPdf.js (one exported async function returning
// a Buffer via pdfDoc.save()), reusing their exact branding/colour constants.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const COMPANY_NAME = 'BD Construction Limited';
const COMPANY_ADDRESS = 'Sussex Pl, Lightwood Rd, Stoke-on-Trent ST3 4TP';

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

  page.drawText(COMPANY_NAME, { x: MARGIN_X, y, size: 16, font: boldFont, color: BLUE_DARK });
  y -= 16;
  page.drawText(COMPANY_ADDRESS, { x: MARGIN_X, y, size: 9, font, color: GREY });
  y -= 34;
  page.drawText('Fire Door Quote', { x: MARGIN_X, y, size: 20, font: boldFont, color: TEXT_DARK });
  y -= 12;
  page.drawLine({ start: { x: MARGIN_X, y }, end: { x: MARGIN_X + FIELD_WIDTH, y }, thickness: 1, color: LINE_GREY });
  y -= 26;

  function labeledValue(label, value) {
    if (!value) return;
    page.drawText(label, { x: MARGIN_X, y, size: 10, font: boldFont, color: GREY });
    y -= 15;
    for (const line of wrapText(value, font, 12, FIELD_WIDTH)) {
      page.drawText(line, { x: MARGIN_X, y, size: 12, font, color: TEXT_DARK });
      y -= 16;
    }
    y -= 6;
  }

  labeledValue('Client', quote.clientName);
  labeledValue('Site Address', quote.siteAddress);
  labeledValue('Date', new Date(quote.createdAt).toLocaleDateString('en-GB'));
  labeledValue('Notes', quote.notes);

  y -= 6;
  page.drawLine({ start: { x: MARGIN_X, y }, end: { x: MARGIN_X + FIELD_WIDTH, y }, thickness: 1, color: LINE_GREY });
  y -= 22;

  function drawTableHeader() {
    page.drawText('Item', { x: COL_ITEM, y, size: 10, font: boldFont, color: GREY });
    drawRight('Qty', COL_QTY_RIGHT, 10, boldFont, GREY);
    drawRight('Unit Price', COL_UNIT_RIGHT, 10, boldFont, GREY);
    drawRight('Total', COL_TOTAL_RIGHT, 10, boldFont, GREY);
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

  ensureRowSpace(3);
  page.drawLine({ start: { x: MARGIN_X, y }, end: { x: MARGIN_X + FIELD_WIDTH, y }, thickness: 1, color: LINE_GREY });
  y -= 24;
  page.drawText('Grand Total', { x: COL_ITEM, y, size: 13, font: boldFont, color: TEXT_DARK });
  drawRight(money(quote.total), COL_TOTAL_RIGHT, 13, boldFont, BLUE_DARK);

  return Buffer.from(await pdfDoc.save());
}

module.exports = { generateFireDoorQuotePdf };
