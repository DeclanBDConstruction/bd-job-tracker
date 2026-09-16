// Calls Claude to draft a full, site-specific RAMS (Method Statement + hazard risk assessment)
// from a short job-info form, for the "Create RAMS" flow in the RAMS tab (see server.js
// POST /api/risk-assessments/generated and riskAssessments.renderGeneratedRamsHtml). The
// Anthropic client is constructed lazily, inside generateRams(), rather than at module load -
// unlike Supabase (supabaseClient.js), a missing ANTHROPIC_API_KEY should only fail the one
// request that needs it, not crash the whole server on startup.

const TRAINING_COMPETENCY_KEYS = [
  'useOfLadders',
  'scaffoldTowers',
  'mobileAccessPlatforms',
  'harnesses',
  'asbestosAwareness',
  'signErection',
  'excavations',
  'electricalDisconnectionInstallation',
];

const HAZARD_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    legislation: { type: 'string' },
    hazard: { type: 'string' },
    peopleAffected: { type: 'string' },
    currentControls: { type: 'array', items: { type: 'string' } },
    currentL: { type: 'integer' },
    currentC: { type: 'integer' },
    additionalControls: { type: 'array', items: { type: 'string' } },
    additionalL: { type: 'integer' },
    additionalC: { type: 'integer' },
    ppe: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'title', 'legislation', 'hazard', 'peopleAffected',
    'currentControls', 'currentL', 'currentC',
    'additionalControls', 'additionalL', 'additionalC', 'ppe',
  ],
  additionalProperties: false,
};

const RAMS_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    projectReference: { type: 'string' },
    descriptionOfWork: { type: 'string' },
    accessEquipmentDescription: { type: 'string' },
    accessRequirements: { type: 'string' },
    otherPlantOrTools: { type: 'string' },
    keyHazardsSummary: { type: 'string' },
    trainingCompetencies: {
      type: 'object',
      properties: Object.fromEntries(TRAINING_COMPETENCY_KEYS.map((k) => [k, { type: 'boolean' }])),
      required: TRAINING_COMPETENCY_KEYS,
      additionalProperties: false,
    },
    requiredPpe: { type: 'array', items: { type: 'string' } },
    fallProtectionMeasures: { type: 'string' },
    workAreaProtection: { type: 'string' },
    firstAidLocation: { type: 'string' },
    nearestAE: { type: 'string' },
    sequenceOfOperations: { type: 'array', items: { type: 'string' } },
    hazards: { type: 'array', items: HAZARD_SCHEMA },
  },
  required: [
    'projectReference', 'descriptionOfWork', 'accessEquipmentDescription', 'accessRequirements',
    'otherPlantOrTools', 'keyHazardsSummary', 'trainingCompetencies', 'requiredPpe',
    'fallProtectionMeasures', 'workAreaProtection', 'firstAidLocation', 'nearestAE',
    'sequenceOfOperations', 'hazards',
  ],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are a UK construction health & safety advisor drafting a RAMS (Risk Assessment & Method Statement) for BD Construction Limited, a UK contractor. Given a short job brief and a library of the company's existing generic hazard templates, produce a complete, site-specific RAMS as structured JSON.

Rules:
- Write in formal, professional UK English, matching how a real construction Method Statement reads (see the field descriptions you're given).
- descriptionOfWork and sequenceOfOperations must be genuinely specific to the task described, not generic boilerplate - mention the actual work, materials, access and welfare arrangements implied by the task.
- sequenceOfOperations must be a realistic, ordered list of numbered steps (as an array of strings, one step per element, without the leading number) covering start-of-day arrival/setup through to end-of-day clear-down.
- For hazards: reuse a library hazard (by title, with its wording adapted to this job) wherever it genuinely applies to the task. Where the task involves something the library doesn't cover (e.g. pressure washing, vegetation/hedge work, working near the public, vehicle loading), write a new hazard entry in the exact same shape. Include every hazard that plausibly applies - don't under-cover real risks, but don't pad with hazards that have nothing to do with the task either.
- currentL, currentC, additionalL, additionalC are each an integer 1-5 (Likelihood x Consequence, per the standard 5x5 matrix); additional-controls figures must be lower than or equal to the current-controls figures for the same hazard, reflecting genuine risk reduction.
- trainingCompetencies: set each boolean true only if that competency is plausibly required for this specific task.
- requiredPpe should list only PPE actually relevant to this task (don't just dump every possible item).
- This is a first draft for a human to review and adjust before anyone works to it - be thorough and realistic, not vague.`;

function buildUserPrompt(formInput, hazardLibrary) {
  const libSummary = hazardLibrary.map((h) => ({
    title: h.title,
    legislation: h.legislation,
    hazard: h.hazard,
    currentControls: h.currentControls,
    currentL: h.currentL,
    currentC: h.currentC,
    additionalControls: h.additionalControls,
    additionalL: h.additionalL,
    additionalC: h.additionalC,
    ppe: h.ppe,
  }));

  return `Job brief:
- Client: ${formInput.client}
- Job number: ${formInput.jobNumber || '(none given)'}
- Site address: ${formInput.location}
- Task: ${formInput.task}
- Start date: ${formInput.startDate}
- Site contact: ${formInput.siteContact || '(none given)'}${formInput.siteContactTel ? ' (' + formInput.siteContactTel + ')' : ''}
- Supervisor: ${formInput.supervisorName || '(none given)'}
- Operatives on site: ${(formInput.employees || []).join(', ') || '(none given)'}
- Contractor/driver: ${formInput.contractorDriver || '(none)'}

Existing generic hazard library (reuse/tailor where relevant, in JSON):
${JSON.stringify(libSummary)}

Draft the full RAMS as JSON matching the given schema.`;
}

async function generateRams(formInput, hazardLibrary) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set - ask an admin to configure it (see README).');
  }

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 8192,
    thinking: { type: 'adaptive' },
    output_config: { format: { type: 'json_schema', schema: RAMS_OUTPUT_SCHEMA } },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(formInput, hazardLibrary) }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) {
    throw new Error('Claude did not return a RAMS draft - try again.');
  }
  return JSON.parse(textBlock.text);
}

module.exports = { generateRams, TRAINING_COMPETENCY_KEYS };
