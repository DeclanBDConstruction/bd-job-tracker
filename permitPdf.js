// Permit to Work: generated once an operative fills in the in-app form on their assignment
// (see the Permit to Work modal in app.js) and hits Save - the filled PDF is built and saved
// straight onto the job in that same request (see POST /api/job-assignments/:id/permit in
// server.js), no separate "open a blank PDF, fill it externally, upload it back" round trip.
// Every field is baked in as plain drawn text (not a fillable AcroForm) since by the time
// this runs the permit is already complete - it's a record, not a template to keep editing.
// Signatures are real hand-drawn images, captured via a <canvas> signature pad in app.js
// (built for finger/stylus input on phones and tablets) and PNG-embedded here.

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const COMPANY_NAME = 'BD Construction Limited';
const COMPANY_ADDRESS = 'Sussex Pl, Lightwood Rd, Stoke-on-Trent ST3 4TP';

const BLUE_DARK = rgb(0.07, 0.31, 0.47);
const GREY = rgb(0.45, 0.45, 0.45);
const LINE_GREY = rgb(0.82, 0.82, 0.82);
const TEXT_DARK = rgb(0.13, 0.13, 0.13);

// Greedy word-wrap so long descriptions don't run off the page edge.
function wrapText(text, font, size, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let current = words[0];
  for (const word of words.slice(1)) {
    const candidate = `${current} ${word}`;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  lines.push(current);
  return lines;
}

async function generatePermitPdf({
  siteName, jobNumber, description, date,
  operativeName, operativeSignatureImage, managerName, managerSignatureImage,
}) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]); // A4
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const marginX = 50;
  const fieldWidth = 495.28;
  const sigBoxWidth = 220;
  const sigBoxHeight = 60;
  let y = 790;

  page.drawText(COMPANY_NAME, { x: marginX, y, size: 16, font: boldFont, color: BLUE_DARK });
  y -= 16;
  page.drawText(COMPANY_ADDRESS, { x: marginX, y, size: 9, font, color: GREY });
  y -= 34;
  page.drawText('Permit to Work', { x: marginX, y, size: 20, font: boldFont });
  y -= 12;
  page.drawLine({ start: { x: marginX, y }, end: { x: marginX + fieldWidth, y }, thickness: 1, color: LINE_GREY });
  y -= 26;

  function labeledValue(label, value) {
    page.drawText(label, { x: marginX, y, size: 10, font: boldFont, color: GREY });
    y -= 15;
    for (const line of wrapText(value, font, 12, fieldWidth)) {
      page.drawText(line, { x: marginX, y, size: 12, font, color: TEXT_DARK });
      y -= 16;
    }
    y -= 10;
  }

  labeledValue('Site Name', siteName);
  labeledValue('Job Number', jobNumber);
  labeledValue('Description of Work', description);
  labeledValue('Date', date);

  y -= 4;
  page.drawLine({ start: { x: marginX, y }, end: { x: marginX + fieldWidth, y }, thickness: 1, color: LINE_GREY });
  y -= 24;

  // Draws a name line plus a bordered box with the signature PNG centred inside it,
  // scaled to fit without distorting its aspect ratio (PDFImage#scaleToFit).
  async function labeledSignature(heading, name, signatureImageBytes) {
    page.drawText(heading, { x: marginX, y, size: 12, font: boldFont, color: BLUE_DARK });
    y -= 20;
    page.drawText('Name', { x: marginX, y, size: 10, font: boldFont, color: GREY });
    y -= 15;
    page.drawText(name || '', { x: marginX, y, size: 12, font, color: TEXT_DARK });
    y -= 24;

    page.drawText('Signature', { x: marginX, y, size: 10, font: boldFont, color: GREY });
    y -= 8;
    const boxTop = y;
    page.drawRectangle({
      x: marginX, y: boxTop - sigBoxHeight, width: sigBoxWidth, height: sigBoxHeight,
      borderColor: LINE_GREY, borderWidth: 1,
    });
    if (signatureImageBytes) {
      const img = await pdfDoc.embedPng(signatureImageBytes);
      const scaled = img.scaleToFit(sigBoxWidth - 12, sigBoxHeight - 12);
      page.drawImage(img, {
        x: marginX + (sigBoxWidth - scaled.width) / 2,
        y: boxTop - sigBoxHeight + (sigBoxHeight - scaled.height) / 2,
        width: scaled.width,
        height: scaled.height,
      });
    }
    y = boxTop - sigBoxHeight - 22;
  }

  await labeledSignature('Operative', operativeName, operativeSignatureImage);
  await labeledSignature('Manager', managerName, managerSignatureImage);

  return Buffer.from(await pdfDoc.save());
}

module.exports = { generatePermitPdf };
