// Generic, editable-on-site risk assessment templates, formatted to match BD Construction's
// own RAMS layout (risk matrix key, L/C/R scoring, current vs. additional controls). These are
// starting points, not finished RAMS documents — the whole point of attaching one to a job is
// that whoever's running that job reviews and adjusts it for the actual site conditions before
// anyone works to it. Kept as static in-code data (not in db.json) since it's reference content
// shared by every job, not something a particular job owns.

const fs = require('fs');
const path = require('path');

const COMPANY_NAME = 'BD Construction Limited';
const COMPANY_ADDRESS = 'Sussex Pl, Lightwood Rd, Stoke-on-Trent ST3 4TP';
const DEFAULT_PEOPLE_AFFECTED = 'Contractors, Employees, Members of the Public, Unauthorised Persons';

let logoDataUri = null;
try {
  const logoPath = path.join(__dirname, 'public', 'assets', 'logo-mark.png');
  logoDataUri = 'data:image/png;base64,' + fs.readFileSync(logoPath).toString('base64');
} catch (e) {
  logoDataUri = null;
}

// likelihood (L) x consequence (C) = risk rating (R), banded the same way as BD Construction's
// own key: 1-2 No Action, 3-6 Monitor, 7-12 Action, 13-16 Urgent Action, 17-25 Stop.
function riskBand(r) {
  if (r <= 2) return { label: 'No Action', slug: 'no-action' };
  if (r <= 6) return { label: 'Monitor', slug: 'monitor' };
  if (r <= 12) return { label: 'Action', slug: 'action' };
  if (r <= 16) return { label: 'Urgent Action', slug: 'urgent-action' };
  return { label: 'Stop', slug: 'stop' };
}

function withRisk(entry) {
  const currentR = entry.currentL * entry.currentC;
  const additionalR = entry.additionalL * entry.additionalC;
  return {
    ...entry,
    peopleAffected: entry.peopleAffected || DEFAULT_PEOPLE_AFFECTED,
    currentR,
    additionalR,
    currentBand: riskBand(currentR),
    additionalBand: riskBand(additionalR),
  };
}

const RISK_ASSESSMENTS = [
  {
    id: 'power-tools',
    title: 'Power Tools',
    legislation: 'PUWER 1998, Electricity at Work Regulations 1989',
    hazard: 'Electric shock, cuts and lacerations, flying debris, noise-induced hearing loss and entanglement in moving parts whilst using power tools.',
    currentControls: [
      'Only trained, competent operatives to use power tools.',
      'Tools, cables and plugs visually checked before use; damaged tools taken out of service immediately.',
      '110V equipment used via a site transformer wherever possible; 230V only with an RCD.',
      'Guards fitted and used correctly at all times.',
      'Tool disconnected from the power supply before changing blades, bits or discs.',
      'Cables kept off the floor and away from walkways.',
    ],
    currentL: 3, currentC: 3,
    additionalControls: [
      'Regular tool inspections undertaken throughout the project.',
      'PAT testing kept in date and checked before use.',
      'Bystanders kept clear of the working area while the tool is in use.',
    ],
    additionalL: 2, additionalC: 2,
    ppe: ['Safety glasses', 'Gloves (cut-resistant where appropriate)', 'Hearing protection', 'Safety footwear'],
  },
  {
    id: 'hand-tools',
    title: 'Hand Tools',
    legislation: 'PUWER 1998',
    hazard: 'Cuts and puncture wounds, eye injury from flying fragments, and musculoskeletal strain from repetitive or forceful use of hand tools.',
    currentControls: [
      'Right tool used for the job — no makeshift substitutes.',
      'Tools inspected before use; damaged, blunt or loose-headed tools taken out of service.',
      'Cutting tools kept sharp — blunt tools need more force and are more likely to slip.',
    ],
    currentL: 2, currentC: 2,
    additionalControls: [
      'Tools stored safely when not in use, not left on walkways or at height.',
      'Sharp or pointed tools carried in a pouch or sheath, never in a pocket.',
    ],
    additionalL: 1, additionalC: 2,
    ppe: ['Gloves', 'Safety glasses (when cutting, chiselling or striking)', 'Safety footwear'],
  },
  {
    id: 'dust-silica',
    title: 'Dust Generation, Cutting & Silica',
    legislation: 'COSHH 2002, Construction (Design and Management) Regulations 2015',
    hazard: 'Inhalation of dust, including respirable crystalline silica from cutting masonry, concrete, tile or brick, causing respiratory irritation and long-term lung damage.',
    currentControls: [
      'On-tool extraction (M-class vacuum) or water suppression used when cutting, chasing, drilling or grinding.',
      'Low-dust methods favoured over dry cutting where practical.',
      'Dusty work carried out in a segregated area or outdoors where possible.',
      'FFP3 (or better) fit-tested RPE worn for any task where dust cannot be fully controlled.',
    ],
    currentL: 3, currentC: 4,
    additionalControls: [
      'Debris damped down before sweeping; fine dust vacuumed with an M-class vacuum, never dry-swept.',
      'Exposure times kept as short as practical and operatives rotated on prolonged dusty tasks.',
      'Supervisor to ensure RPE is worn correctly.',
    ],
    additionalL: 2, additionalC: 3,
    ppe: ['FFP3 (or better) respirator, fit-tested', 'Safety glasses / goggles', 'Coveralls for heavy dust work'],
  },
  {
    id: 'working-at-height',
    title: 'Working at Height',
    legislation: 'Work at Height Regulations 2005',
    hazard: 'Falls from scaffolding, roofs, towers or ladders resulting in serious injury or fatality. Falling tools or materials may injure persons below.',
    currentControls: [
      'All works planned in accordance with the Work at Height Regulations 2005.',
      'Right access equipment used for the task and duration — podium steps, tower scaffold or MEWP rather than an ordinary ladder for anything other than short-duration light work.',
      'Only trained, and where required certified, operatives to use access equipment.',
      'Access equipment inspected before use and after any incident.',
      'Area below barriered off and signed to prevent people walking underneath.',
    ],
    currentL: 4, currentC: 5,
    additionalControls: [
      'Harnesses and lanyards used where identified within the task-specific assessment.',
      'Tools and materials secured against falling — tool lanyards or toe boards.',
      'Weather monitored continuously; work suspended in high winds, ice or poor visibility.',
      'Supervisor to undertake routine monitoring throughout the shift.',
    ],
    additionalL: 2, additionalC: 5,
    ppe: ['Hard hat', 'Safety footwear with good grip', 'Harness and lanyard where fall restraint/arrest is specified'],
  },
  {
    id: 'access-towers-scaffolding',
    title: 'Access Towers & Scaffolding',
    legislation: 'Work at Height Regulations 2005',
    hazard: 'Scaffold or tower collapse, unsafe alterations or defective components resulting in falls from height, falling materials or structural failure.',
    currentControls: [
      'Scaffold erected, altered and dismantled only by CISRS qualified scaffolders; towers by PASMA-trained operatives.',
      'Handover certificate obtained before use.',
      'Weekly statutory inspections completed and scaffold tags displayed.',
      'Guardrails, toe boards and brick guards fitted before use.',
      'No unauthorised alterations permitted; castors locked before climbing a mobile tower.',
    ],
    currentL: 4, currentC: 5,
    additionalControls: [
      'Daily visual inspections undertaken by a competent person.',
      'Damaged components replaced immediately.',
      'Exclusion zones maintained during scaffold alterations.',
      'Additional inspections undertaken following severe weather.',
    ],
    additionalL: 2, additionalC: 5,
    ppe: ['Hard hat', 'Safety footwear', 'Harness and lanyard if working from an incomplete lift'],
  },
  {
    id: 'ladders-stepladders',
    title: 'Ladders & Stepladders',
    legislation: 'Work at Height Regulations 2005',
    hazard: 'Falls from the ladder, ladder slipping or toppling, overreaching causing loss of balance, and falling tools or materials.',
    currentControls: [
      'Ladders used only for short-duration, light work (typically under 30 minutes) — proper access equipment used otherwise.',
      'Ladder checked before use: feet, rungs, stiles and locking mechanisms all sound.',
      'Set up on firm, level ground; stability device used or ladder footed where needed.',
    ],
    currentL: 3, currentC: 4,
    additionalControls: [
      'Three points of contact maintained at all times; ladder moved rather than overreaching.',
      'Top two rungs/steps not stood on unless designed for it.',
      'Supervisor to spot-check ladder use during the shift.',
    ],
    additionalL: 2, additionalC: 3,
    ppe: ['Safety footwear', 'Hard hat where there is an overhead hazard'],
  },
  {
    id: 'painting-decorating',
    title: 'Painting & Decorating',
    legislation: 'COSHH 2002',
    hazard: 'Exposure to paint fumes causing respiratory and skin irritation, slips caused by spillages, and falls whilst painting at height.',
    currentControls: [
      'Low VOC / water-based paints used where the specification allows.',
      'COSHH assessment / product data sheet checked for each coating before use.',
      'Adequate ventilation maintained — windows/doors open or extraction used in enclosed spaces.',
      'Spillages cleaned up immediately; wet-painted areas and floors signed and barriered off.',
    ],
    currentL: 3, currentC: 3,
    additionalControls: [
      'Respiratory protection worn where ventilation is limited.',
      'Paint containers kept closed when not in use; soaked rags disposed of safely.',
      'Supervisor to monitor safe storage of flammable materials.',
    ],
    additionalL: 2, additionalC: 2,
    ppe: ['Gloves (solvent-resistant for oil-based products)', 'Eye protection when spraying or working overhead', 'Suitable respirator (e.g. A-type filter) in confined or poorly ventilated spaces'],
  },
  {
    id: 'manual-handling',
    title: 'Manual Handling',
    legislation: 'Manual Handling Operations Regulations 1992',
    hazard: 'Lifting materials, tools or equipment may cause strains, sprains or musculoskeletal injuries, or crush injuries when carrying or setting down loads.',
    currentControls: [
      'Manual handling avoided where possible — trolleys, sack barrows or mechanical aids used instead.',
      'Load assessed before lifting: weight, size, shape and the route to be travelled.',
      'Heavy or awkward loads broken down into smaller loads, or a team lift used.',
      'Good lifting technique used — bend the knees, keep the load close, avoid twisting.',
    ],
    currentL: 4, currentC: 3,
    additionalControls: [
      'Routes kept clear of trip hazards; destination checked as clear before setting off.',
      'Lifting tasks rotated between operatives on repetitive work.',
      'Supervisor to monitor lifting technique.',
    ],
    additionalL: 2, additionalC: 2,
    ppe: ['Gloves', 'Safety footwear'],
  },
  {
    id: 'noise',
    title: 'Noise',
    legislation: 'Control of Noise at Work Regulations 2005',
    hazard: 'Noise-induced hearing loss and tinnitus from working with or near loud tools or plant, and difficulty hearing warnings/alarms.',
    currentControls: [
      'Quieter tools, equipment or methods used where practical (e.g. quiet-cut saws, off-site cutting).',
      'Hearing protection zones established around consistently noisy work and signed.',
      'Tools and plant maintained so they run as quietly as designed.',
    ],
    currentL: 3, currentC: 2,
    additionalControls: [
      'Exposure time limited on noisy tasks and operatives rotated where possible.',
    ],
    additionalL: 2, additionalC: 1,
    ppe: ['Hearing protection (ear defenders or plugs) — mandatory in designated zones'],
  },
  {
    id: 'hot-works',
    title: 'Hot Works',
    legislation: 'Regulatory Reform (Fire Safety) Order 2005',
    hazard: 'Fire from sparks, heat or naked flame igniting nearby materials, burns, fumes from welding/soldering/cutting, and explosion risk from gas equipment.',
    currentControls: [
      'Hot works permit issued and signed off before work starts.',
      'Combustible materials cleared from the area; anything that can\'t be moved covered with a fire-resistant blanket.',
      'Suitable fire extinguisher kept at the work location at all times.',
      'Gas equipment (hoses, regulators, torches) checked before use and used only in well-ventilated areas.',
    ],
    currentL: 3, currentC: 4,
    additionalControls: [
      'Fire watch posted during the work and for at least 30–60 minutes after it finishes.',
    ],
    additionalL: 2, additionalC: 3,
    ppe: ['Welding gauntlets / heat-resistant gloves', 'Eye/face protection appropriate to the process', 'Flame-resistant clothing'],
  },
  {
    id: 'slips-trips-falls',
    title: 'Slips, Trips & Housekeeping',
    legislation: 'Workplace (Health, Safety and Welfare) Regulations 1992',
    hazard: 'Uneven ground, trailing cables, debris and stored materials may cause slips, trips and falls on the level, resulting in injury.',
    currentControls: [
      'Good housekeeping maintained; walkways and work areas kept clear of tools, offcuts and packaging.',
      'Cables and hoses routed away from walkways, or covered where they must cross.',
      'Spillages mopped up immediately and warning signage used while floors dry.',
    ],
    currentL: 3, currentC: 3,
    additionalControls: [
      'Supervisor to undertake housekeeping inspections throughout the day.',
      'Trip hazards in the floor (holes, upstands, loose boards) made good or barriered off until fixed.',
      'Work areas and access routes kept well lit.',
    ],
    additionalL: 2, additionalC: 2,
    ppe: ['Safety footwear with slip-resistant soles'],
  },
  {
    id: 'electrical-equipment',
    title: 'Electrical Equipment & Temporary Supplies',
    legislation: 'Electricity at Work Regulations 1989',
    hazard: 'Electric shock or electrocution, arc flash/burns, and fire from damaged cables, temporary supplies or overloaded circuits.',
    currentControls: [
      '110V equipment used on site as standard; where 230V must be used, protected by an RCD.',
      'All portable electrical equipment PAT tested and in-date; label checked before use.',
      'Cables, plugs and equipment visually inspected before each use — not used if damaged.',
      'Temporary supplies and distribution boards installed and inspected by a competent electrician.',
    ],
    currentL: 3, currentC: 4,
    additionalControls: [
      'No unauthorised work on fixed electrical installations — isolated and locked off before any work near them.',
      'Cables kept off wet ground and away from sharp edges or vehicle routes.',
    ],
    additionalL: 2, additionalC: 3,
    ppe: ['Insulated tools when working on or near live parts (authorised persons only)', 'Safety footwear'],
  },
  {
    id: 'coshh',
    title: 'COSHH / Hazardous Substances',
    legislation: 'Control of Substances Hazardous to Health (COSHH) Regulations 2002',
    hazard: 'Skin irritation or burns, inhalation of fumes/vapours/dust, eye injury from splashes, and fire/reaction hazards from hazardous substances.',
    currentControls: [
      'COSHH assessment / safety data sheet checked before any hazardous substance is brought on site.',
      'Less hazardous product substituted wherever possible.',
      'Chemicals stored in their original, labelled containers, away from heat and incompatible substances.',
      'Used in well-ventilated areas, with local extraction where specified on the data sheet.',
    ],
    currentL: 3, currentC: 4,
    additionalControls: [
      'Spill control materials available for the substances in use.',
      'Hands washed before eating, drinking or smoking after handling chemicals.',
    ],
    additionalL: 2, additionalC: 2,
    ppe: ['Gloves suited to the substance (check the data sheet)', 'Eye protection', 'Respirator where the data sheet requires it'],
  },
  {
    id: 'asbestos-awareness',
    title: 'Asbestos Awareness',
    legislation: 'Control of Asbestos Regulations 2012',
    hazard: 'Inhalation of asbestos fibres from disturbed asbestos-containing materials (ACMs), causing mesothelioma, lung cancer or asbestosis — a long-latency, irreversible disease.',
    currentControls: [
      'Site/building asbestos register or refurbishment survey checked before starting any work that disturbs the fabric of a pre-2000 building.',
      'If suspect material is found (or no survey exists), work stops immediately, the material is not disturbed further, and it is reported before continuing.',
      'No drilling, cutting, sanding or breaking of any material believed to contain asbestos.',
    ],
    currentL: 2, currentC: 5,
    additionalControls: [
      'Only licensed/trained contractors used to remove or work on confirmed ACMs.',
      'All site operatives to have received asbestos awareness (Category A) training appropriate to construction work.',
    ],
    additionalL: 1, additionalC: 5,
    ppe: ['Not a substitute for stopping work — PPE alone does not make asbestos work safe; specialist RPE and disposable coveralls are for licensed/trained personnel only'],
  },
].map(withRisk);

function listRiskAssessments() {
  return RISK_ASSESSMENTS;
}

function getRiskAssessment(id) {
  return RISK_ASSESSMENTS.find((r) => r.id === id) || null;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const RISK_KEY_ROWS = [
  ['1 – Very Unlikely', '1 – Insignificant', '1-2 No Action', 'no-action'],
  ['2 – Unlikely', '2 – Minor', '3–6 Monitor', 'monitor'],
  ['3 - Fairly Likely', '3 - Moderate', '7-12 Action', 'action'],
  ['4 - Likely', '4 - Major', '13-16 Urgent Action', 'urgent-action'],
  ['5 - Very Likely', '5 - Catastrophic', '17-25 Stop', 'stop'],
];

// Renders a self-contained, printable HTML document for a risk assessment, formatted to match
// BD Construction's own RAMS layout, so it can be saved straight into a job's RAMS folder or
// downloaded on its own.
function renderHtml(ra) {
  const today = new Date().toLocaleDateString('en-GB');
  const list = (items) => `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;
  const keyRows = RISK_KEY_ROWS.map(([l, c, r, slug], i) => `
    <tr>
      ${i === 0 ? `<td rowspan="${RISK_KEY_ROWS.length}" class="company-cell"><span class="company-name">${escapeHtml(COMPANY_NAME)}</span><br><span class="company-address">${escapeHtml(COMPANY_ADDRESS)}</span></td>` : ''}
      <td>${escapeHtml(l)}</td><td>${escapeHtml(c)}</td><td class="key-band ${slug}">${escapeHtml(r)}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(ra.title)} — Risk Assessment</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; color: #1e2733; max-width: 900px; margin: 24px auto; padding: 0 20px; line-height: 1.4; font-size: 13px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #999; padding: 6px 8px; text-align: left; vertical-align: top; }
  .header-table td { border: none; padding: 4px 8px; }
  .logo { height: 70px; }
  .company-name { font-weight: 700; font-size: 14px; }
  .company-address { font-size: 12px; color: #444; }
  .key-table th { background: #6d2f5f; color: #fff; font-size: 11px; }
  .key-band { font-weight: 700; text-align: center; }
  .key-band.no-action { background: #b6d95a; }
  .key-band.monitor { background: #d7e79b; }
  .key-band.action { background: #ffe066; }
  .key-band.urgent-action { background: #f4a13a; }
  .key-band.stop { background: #e5514f; color: #fff; }
  .section-title { background: #6d2f5f; color: #fff; font-weight: 700; padding: 6px 8px; font-size: 12px; }
  .hazard-table th { background: #6d2f5f; color: #fff; font-size: 11px; }
  .hazard-title { font-weight: 700; margin-bottom: 6px; }
  .r-cell { font-weight: 700; text-align: center; }
  .lc-cell { text-align: center; }
  ul { margin: 4px 0; padding-left: 18px; }
  .notice { margin-top: 20px; padding: 10px 14px; background: #fef0dc; border: 1px solid #f4d49b; border-radius: 6px; font-size: 12px; color: #7a4f00; }
  .footer-table td { font-weight: 700; background: #6d2f5f; color: #fff; width: 180px; }
  .footer-table .value { background: #fff; color: #1e2733; font-weight: 400; }
  .top-grid { display: flex; gap: 0; margin-bottom: 12px; }
</style>
</head>
<body>
  ${logoDataUri ? `<img class="logo" src="${logoDataUri}" alt="${escapeHtml(COMPANY_NAME)}">` : ''}

  <table class="key-table">
    <tr><th style="width:24%">Company</th><th style="width:24%">Likelihood</th><th style="width:24%">Consequences</th><th style="width:28%">Current Risk Rating</th></tr>
    ${keyRows}
  </table>

  <table style="margin-top:14px">
    <tr><td class="section-title" style="width:20%">Task Description</td><td colspan="3">${escapeHtml(ra.title)}</td></tr>
    <tr><td class="section-title">People Affected</td><td colspan="3">${escapeHtml(ra.peopleAffected)}</td></tr>
  </table>

  <table style="margin-top:14px">
    <tr>
      <th class="hazard-table" style="width:20%">Hazard &amp; Potential Harm</th>
      <th class="hazard-table" style="width:28%">Current Risk Controls</th>
      <th class="hazard-table" style="width:4%">L</th>
      <th class="hazard-table" style="width:4%">C</th>
      <th class="hazard-table" style="width:4%">R</th>
      <th class="hazard-table" style="width:28%">Additional Risk Controls</th>
      <th class="hazard-table" style="width:4%">L</th>
      <th class="hazard-table" style="width:4%">C</th>
      <th class="hazard-table" style="width:4%">R</th>
    </tr>
    <tr>
      <td><div class="hazard-title">${escapeHtml(ra.title)}</div>${escapeHtml(ra.hazard)}</td>
      <td>${list(ra.currentControls)}</td>
      <td class="lc-cell">${ra.currentL}</td>
      <td class="lc-cell">${ra.currentC}</td>
      <td class="r-cell key-band ${ra.currentBand.slug}">${ra.currentR}</td>
      <td>${list(ra.additionalControls)}</td>
      <td class="lc-cell">${ra.additionalL}</td>
      <td class="lc-cell">${ra.additionalC}</td>
      <td class="r-cell key-band ${ra.additionalBand.slug}">${ra.additionalR}</td>
    </tr>
  </table>

  <table style="margin-top:14px">
    <tr><td class="section-title" style="width:20%">PPE Required</td><td colspan="3">${escapeHtml(ra.ppe.join(', '))}</td></tr>
    ${ra.legislation ? `<tr><td class="section-title">Relevant Legislation</td><td colspan="3">${escapeHtml(ra.legislation)}</td></tr>` : ''}
  </table>

  <div class="notice">This is a generic template generated ${today}. It must be reviewed and adjusted for the specific site and task conditions before anyone works to it, and re-issued if conditions change.</div>

  <table class="footer-table" style="margin-top:20px">
    <tr><td>Assessors Name:</td><td class="value">&nbsp;</td></tr>
    <tr><td>Date Of Assessment:</td><td class="value">&nbsp;</td></tr>
    <tr><td>Approved By:</td><td class="value">&nbsp;</td></tr>
    <tr><td>Date Of Review:</td><td class="value">&nbsp;</td></tr>
  </table>
</body>
</html>
`;
}

// Renders a self-contained HTML snapshot of an operative's submitted RAMS (method statement +
// every hazard they picked/adjusted + their signature), in the same visual style as renderHtml
// above, so it saves straight into the job's RAMS document category (see the
// /api/job-assignments/:id/rams route in server.js) and surveyors/admins see it alongside every
// other RAMS attached to that job, not just from the Job Assignments tab.
function renderRamsHtml({ methodStatement, hazards, operativeName, signatureImage, createdAt, jobReference, task }) {
  const submittedDate = new Date(createdAt).toLocaleDateString('en-GB');
  const list = (items) => `<ul>${(items || []).map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`;
  const keyRows = RISK_KEY_ROWS.map(([l, c, r, slug], i) => `
    <tr>
      ${i === 0 ? `<td rowspan="${RISK_KEY_ROWS.length}" class="company-cell"><span class="company-name">${escapeHtml(COMPANY_NAME)}</span><br><span class="company-address">${escapeHtml(COMPANY_ADDRESS)}</span></td>` : ''}
      <td>${escapeHtml(l)}</td><td>${escapeHtml(c)}</td><td class="key-band ${slug}">${escapeHtml(r)}</td>
    </tr>
  `).join('');

  const hazardBlocks = (hazards || []).map((h) => {
    const currentR = h.currentL * h.currentC;
    const additionalR = h.additionalL * h.additionalC;
    const currentBand = riskBand(currentR);
    const additionalBand = riskBand(additionalR);
    return `
      <table style="margin-top:14px">
        <tr>
          <th class="hazard-table" style="width:20%">Hazard &amp; Potential Harm</th>
          <th class="hazard-table" style="width:28%">Current Risk Controls</th>
          <th class="hazard-table" style="width:4%">L</th>
          <th class="hazard-table" style="width:4%">C</th>
          <th class="hazard-table" style="width:4%">R</th>
          <th class="hazard-table" style="width:28%">Additional Risk Controls</th>
          <th class="hazard-table" style="width:4%">L</th>
          <th class="hazard-table" style="width:4%">C</th>
          <th class="hazard-table" style="width:4%">R</th>
        </tr>
        <tr>
          <td><div class="hazard-title">${escapeHtml(h.title)}</div>${escapeHtml(h.hazard || '')}</td>
          <td>${list(h.currentControls)}</td>
          <td class="lc-cell">${h.currentL}</td>
          <td class="lc-cell">${h.currentC}</td>
          <td class="r-cell key-band ${currentBand.slug}">${currentR}</td>
          <td>${list(h.additionalControls)}</td>
          <td class="lc-cell">${h.additionalL}</td>
          <td class="lc-cell">${h.additionalC}</td>
          <td class="r-cell key-band ${additionalBand.slug}">${additionalR}</td>
        </tr>
        ${(h.ppe && h.ppe.length) ? `<tr><td class="section-title">PPE Required</td><td colspan="8">${escapeHtml(h.ppe.join(', '))}</td></tr>` : ''}
      </table>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>RAMS — ${escapeHtml(jobReference || '')}</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; color: #1e2733; max-width: 900px; margin: 24px auto; padding: 0 20px; line-height: 1.4; font-size: 13px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #999; padding: 6px 8px; text-align: left; vertical-align: top; }
  .logo { height: 70px; }
  .company-name { font-weight: 700; font-size: 14px; }
  .company-address { font-size: 12px; color: #444; }
  .key-table th { background: #6d2f5f; color: #fff; font-size: 11px; }
  .key-band { font-weight: 700; text-align: center; }
  .key-band.no-action { background: #b6d95a; }
  .key-band.monitor { background: #d7e79b; }
  .key-band.action { background: #ffe066; }
  .key-band.urgent-action { background: #f4a13a; }
  .key-band.stop { background: #e5514f; color: #fff; }
  .section-title { background: #6d2f5f; color: #fff; font-weight: 700; padding: 6px 8px; font-size: 12px; }
  .hazard-table th { background: #6d2f5f; color: #fff; font-size: 11px; }
  .hazard-title { font-weight: 700; margin-bottom: 6px; }
  .r-cell { font-weight: 700; text-align: center; }
  .lc-cell { text-align: center; }
  ul { margin: 4px 0; padding-left: 18px; }
  .method-statement { white-space: pre-wrap; }
  .footer-table td { font-weight: 700; background: #6d2f5f; color: #fff; width: 180px; }
  .footer-table .value { background: #fff; color: #1e2733; font-weight: 400; }
  .signature-img { max-width: 300px; border: 1px solid #999; border-radius: 4px; }
</style>
</head>
<body>
  ${logoDataUri ? `<img class="logo" src="${logoDataUri}" alt="${escapeHtml(COMPANY_NAME)}">` : ''}

  <table class="key-table">
    <tr><th style="width:24%">Company</th><th style="width:24%">Likelihood</th><th style="width:24%">Consequences</th><th style="width:28%">Current Risk Rating</th></tr>
    ${keyRows}
  </table>

  <table style="margin-top:14px">
    <tr><td class="section-title" style="width:20%">Job</td><td colspan="3">${escapeHtml(jobReference || '')}</td></tr>
    <tr><td class="section-title">Task</td><td colspan="3">${escapeHtml(task || '')}</td></tr>
  </table>

  <table style="margin-top:14px">
    <tr><td class="section-title" style="width:20%">Method Statement</td><td colspan="3" class="method-statement">${escapeHtml(methodStatement)}</td></tr>
  </table>

  ${hazardBlocks}

  <table class="footer-table" style="margin-top:20px">
    <tr><td>Signed</td><td class="value">${escapeHtml(operativeName)}</td></tr>
    <tr><td>Date</td><td class="value">${submittedDate}</td></tr>
    <tr><td>Signature</td><td class="value">${signatureImage ? `<img class="signature-img" src="${signatureImage}" alt="Signature">` : ''}</td></tr>
  </table>
</body>
</html>
`;
}

module.exports = { listRiskAssessments, getRiskAssessment, renderHtml, renderRamsHtml, riskBand };
