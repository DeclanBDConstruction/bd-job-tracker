// Fire Door Quote PDF: generated on demand from a saved fire_door_quotes row - the ticked
// items are already snapshotted with name/price/quantity at save time (see
// createFireDoorQuote in db.js), so this just lays them out as a table with VAT and a grand
// total.
//
// Deliberately matches the company's real "Quotes Example.xlsx" estimate template as closely
// as a fixed-layout PDF can match a spreadsheet: same logo image (public/assets/logo-full.jpg,
// confirmed to be the exact same PNG embedded in the xlsx), same section labels/wording pulled
// verbatim from the xlsx's shared strings, same brand colours read out of its styles.xml
// (WORK ESTIMATE in green #00B050, small labels in the xlsx's theme "dk2" blue #3A5D9C, the
// itemized-costs header row shaded with its "accent1 tint 0.8" light-blue band), and the exact
// disclaimer paragraph. Same pdf-lib module shape as permitPdf.js/cadPdf.js (one exported async
// function returning a Buffer via pdfDoc.save()).

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const LOGO_PATH = path.join(__dirname, 'public', 'assets', 'logo-full.jpg');

const COMPANY_NAME = 'BD Construction Limited';
const COMPANY_ADDRESS_LINES = ['Unit 1 Harvey Court', 'Harvey lane Golborne', 'WA3 3RX'];
const COMPANY_PHONE = '01942 725548';
const COMPANY_EMAIL = 'Info@bdconstruction.co.uk';

// Verbatim from the company's own estimate template, so every generated quote carries the
// same disclaimer their real quotes always have.
const DISCLAIMER = 'Note:- This is not a contract or a bill. It is our best estimate at the total price to '
  + 'complete the works stated above, based on our initial survey. If any additional works and labour are '
  + 'required we will inform you and send an update in costs.';

// Colours lifted straight out of the xlsx's xl/styles.xml / xl/theme/theme1.xml rather than
// guessed, so the PDF reads as the same document: GREEN is the font colour used on "WORK
// ESTIMATE" (#00B050), LABEL_BLUE is the theme "dk2" colour (#3A5D9C) used on small field
// labels, HEADER_BAND is "accent1" (#3B4E87) tinted 80% lighter, the fill behind the itemized
// costs header row.
const GREEN = rgb(0 / 255, 176 / 255, 80 / 255);
const LABEL_BLUE = rgb(58 / 255, 93 / 255, 156 / 255);
const HEADER_BAND = rgb(216 / 255, 220 / 255, 231 / 255);
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
  const logoImage = await pdfDoc.embedJpg(fs.readFileSync(LOGO_PATH));
  const logo = logoImage.scaleToFit(120, 65);

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

  // Letterhead: the real logo (same PNG the xlsx has embedded in cell A1) with the company's
  // address/phone/email beneath it, exactly like the left-hand column of the spreadsheet.
  // "WORK ESTIMATE" + reference/date sit top-right, in the xlsx's own green/blue brand colours.
  const headerTopY = y;
  page.drawImage(logoImage, { x: MARGIN_X, y: headerTopY - logo.height, width: logo.width, height: logo.height });
  y -= logo.height + 6;
  for (const line of COMPANY_ADDRESS_LINES) {
    page.drawText(line, { x: MARGIN_X, y, size: 9, font, color: GREY });
    y -= 12;
  }
  page.drawText(`${COMPANY_PHONE}  |  ${COMPANY_EMAIL}`, { x: MARGIN_X, y, size: 9, font, color: GREY });
  const leftColumnBottomY = y;

  y = headerTopY;
  drawRight('WORK ESTIMATE', COL_TOTAL_RIGHT, 18, boldFont, GREEN);
  y -= 22;
  drawRight(`ESTIMATE #: ${estimateNumber(quote)}`, COL_TOTAL_RIGHT, 10, boldFont, LABEL_BLUE);
  y -= 14;
  drawRight(`DATE: ${new Date(quote.createdAt).toLocaleDateString('en-GB')}`, COL_TOTAL_RIGHT, 10, boldFont, LABEL_BLUE);
  const rightColumnBottomY = y;

  // The separator sits below whichever column (logo+address, or title+reference) runs lower,
  // with enough clearance that it can't collide with that column's last line of text - a fixed
  // offset here previously clipped straight through the phone/email line on short logos.
  y = Math.min(leftColumnBottomY, rightColumnBottomY) - 14;
  page.drawLine({ start: { x: MARGIN_X, y }, end: { x: MARGIN_X + FIELD_WIDTH, y }, thickness: 1, color: LINE_GREY });
  y -= 24;

  // FTAO (For The Attention Of) client block - exact label from the template.
  page.drawText('FTAO :-', { x: MARGIN_X, y, size: 10, font: boldFont, color: LABEL_BLUE });
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

  // Title - the auto-generated (or hand-written) summary of what's being quoted for, same
  // label as the merged "Title" block on the real template.
  page.drawText('Title', { x: MARGIN_X, y, size: 10, font: boldFont, color: LABEL_BLUE });
  y -= 15;
  for (const line of wrapText(quote.notes || 'Fire door works as specified.', font, 12, FIELD_WIDTH)) {
    page.drawText(line, { x: MARGIN_X, y, size: 12, font, color: TEXT_DARK });
    y -= 16;
  }

  y -= 10;
  page.drawLine({ start: { x: MARGIN_X, y }, end: { x: MARGIN_X + FIELD_WIDTH, y }, thickness: 1, color: LINE_GREY });
  y -= 6;

  // Itemized costs header row, shaded with the same light-blue band the xlsx uses behind its
  // "ITEMIZED COSTS / QTY / UNIT PRICE / AMOUNT" row.
  function drawTableHeader() {
    page.drawRectangle({ x: MARGIN_X, y: y - 18, width: FIELD_WIDTH, height: 22, color: HEADER_BAND });
    page.drawText('ITEMIZED COSTS', { x: COL_ITEM + 6, y, size: 10, font: boldFont, color: TEXT_DARK });
    drawRight('QTY', COL_QTY_RIGHT, 10, boldFont, TEXT_DARK);
    drawRight('UNIT PRICE', COL_UNIT_RIGHT, 10, boldFont, TEXT_DARK);
    drawRight('AMOUNT', COL_TOTAL_RIGHT - 6, 10, boldFont, TEXT_DARK);
    y -= 26;
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

  page.drawText('TOTAL ESTIMATE', { x: COL_UNIT_RIGHT - 120, y, size: 11, font: boldFont, color: TEXT_DARK });
  drawRight(money(quote.subtotal), COL_TOTAL_RIGHT, 11, font, TEXT_DARK);
  y -= 16;
  page.drawText('VAT @ 20%', { x: COL_UNIT_RIGHT - 120, y, size: 11, font, color: TEXT_DARK });
  drawRight(money(quote.vat), COL_TOTAL_RIGHT, 11, font, TEXT_DARK);
  y -= 18;
  page.drawLine({ start: { x: COL_UNIT_RIGHT - 120, y }, end: { x: MARGIN_X + FIELD_WIDTH, y }, thickness: 1, color: LINE_GREY });
  y -= 18;
  page.drawText('TOTAL', { x: COL_UNIT_RIGHT - 120, y, size: 14, font: boldFont, color: GREEN });
  drawRight(money(quote.total), COL_TOTAL_RIGHT, 14, boldFont, GREEN);

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
  page.drawText(COMPANY_NAME, { x: MARGIN_X, y, size: 11, font: boldFont, color: LABEL_BLUE });
  y -= 14;
  page.drawText(`${COMPANY_PHONE}  |  ${COMPANY_EMAIL}`, { x: MARGIN_X, y, size: 9, font, color: GREY });

  return Buffer.from(await pdfDoc.save());
}

module.exports = { generateFireDoorQuotePdf };
