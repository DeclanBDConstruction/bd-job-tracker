// Permit to Work: a fillable PDF an operative opens from their assignment once the job's
// done, types their name/signature into (plus the manager's), and can upload back onto the
// job (see the /api/job-assignments/:id/permit routes in server.js). Site name, job number,
// description and date come pre-filled from the assignment/job; the signature fields are
// just typed text (a real fillable PDF can't capture a drawn signature without a dedicated
// signing pad built into the app, which this isn't).

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const COMPANY_NAME = 'BD Construction Limited';
const COMPANY_ADDRESS = 'Sussex Pl, Lightwood Rd, Stoke-on-Trent ST3 4TP';

const BLUE_DARK = rgb(0.07, 0.31, 0.47);
const GREY = rgb(0.45, 0.45, 0.45);
const LINE_GREY = rgb(0.82, 0.82, 0.82);

async function generatePermitPdf({ siteName, jobNumber, description, date }) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]); // A4
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const form = pdfDoc.getForm();

  const marginX = 50;
  const fieldWidth = 495.28;
  let y = 790;

  page.drawText(COMPANY_NAME, { x: marginX, y, size: 16, font: boldFont, color: BLUE_DARK });
  y -= 16;
  page.drawText(COMPANY_ADDRESS, { x: marginX, y, size: 9, font, color: GREY });
  y -= 34;
  page.drawText('Permit to Work', { x: marginX, y, size: 20, font: boldFont });
  y -= 12;
  page.drawLine({ start: { x: marginX, y }, end: { x: marginX + fieldWidth, y }, thickness: 1, color: LINE_GREY });
  y -= 28;

  function labeledField(label, name, value, height) {
    page.drawText(label, { x: marginX, y, size: 10, font: boldFont });
    y -= 16;
    const field = form.createTextField(name);
    if (height > 22) field.enableMultiline();
    field.setText(value || '');
    field.addToPage(page, {
      x: marginX,
      y: y - height,
      width: fieldWidth,
      height,
      borderWidth: 1,
      borderColor: LINE_GREY,
    });
    y -= (height + 18);
  }

  labeledField('Site Name', 'siteName', siteName, 22);
  labeledField('Job Number', 'jobNumber', jobNumber, 22);
  labeledField('Description of Work', 'description', description, 60);
  labeledField('Date', 'date', date, 22);

  y -= 6;
  page.drawLine({ start: { x: marginX, y }, end: { x: marginX + fieldWidth, y }, thickness: 1, color: LINE_GREY });
  y -= 24;

  page.drawText('Operative', { x: marginX, y, size: 12, font: boldFont, color: BLUE_DARK });
  y -= 22;
  labeledField('Name', 'operativeName', '', 22);
  labeledField('Signature', 'operativeSignature', '', 22);

  y -= 4;
  page.drawText('Manager', { x: marginX, y, size: 12, font: boldFont, color: BLUE_DARK });
  y -= 22;
  labeledField('Name', 'managerName', '', 22);
  labeledField('Signature', 'managerSignature', '', 22);

  return Buffer.from(await pdfDoc.save());
}

module.exports = { generatePermitPdf };
