// A Hugging Face tool call may suggest the first step of a monster turn.
// The suggestion is kept only when it is already in the tactician's legal list.
// Dice and hit points are never decided here. With no HF_TOKEN, the tactician
// runs the turn by itself.

const { legalOptions } = require('./monsterTurn.js');

const HF_URL = 'https://router.huggingface.co/v1/chat/completions';
const DEFAULT_MODEL = 'Qwen/Qwen2.5-7B-Instruct';

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'attack',
      description: 'Use one action from the legal attack list. For an area, copy its aim square.',
      parameters: {
        type: 'object',
        properties: {
          actionName: { type: 'string' },
          targetId: { type: 'number' },
          x: { type: 'number' },
          y: { type: 'number' },
        },
        required: ['actionName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move',
      description: 'Walk to one square from the legal move list.',
      parameters: {
        type: 'object',
        properties: { x: { type: 'number' }, y: { type: 'number' } },
        required: ['x', 'y'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dash',
      description: 'Spend the action to dash, only if dash is legal.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'end',
      description: 'End the turn, only if end is legal.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

function num(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sameSquare(left, right) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.x === right.x && left.y === right.y;
}

// proposal is { name, actionName?, targetId?, x?, y? } from a tool call.
// Anything not on the legal list falls back to the tactician.
function acceptProposal(proposal, legal, fallback) {
  const step = fallback || legal.step;
  if (!proposal || !proposal.name) return step;

  if (proposal.name === 'end') return legal.end ? { type: 'end', reason: 'advisor' } : step;
  if (proposal.name === 'dash') return legal.dash ? { type: 'dash' } : step;

  if (proposal.name === 'move') {
    const x = num(proposal.x);
    const y = num(proposal.y);
    const move = (legal.moves || []).find((entry) => entry.x === x && entry.y === y);
    if (!move) return step;
    return { type: 'move', x: move.x, y: move.y, feet: move.feet };
  }

  if (proposal.name === 'attack') {
    const attack = (legal.attacks || []).find((entry) => {
      if (entry.actionName !== proposal.actionName) return false;
      const wanted = num(proposal.targetId);
      if (entry.targetId !== wanted) return false;
      const x = num(proposal.x);
      const square = x == null ? null : { x, y: num(proposal.y) };
      return sameSquare(entry.square, square);
    });
    if (!attack) return step;
    return {
      type: 'attack',
      actionName: attack.actionName,
      targetId: attack.targetId,
      square: attack.square || null,
    };
  }

  return step;
}

function battlefieldText(ctx, legal) {
  const lines = ctx.tokens.map((token) => {
    return `${token.name} id ${token.id} team ${token.team} at ${token.x},${token.y} hp ${token.hp}`;
  });
  const attacks = (legal.attacks || []).slice(0, 8).map((attack) => {
    const aim = attack.square ? ` aim ${attack.square.x},${attack.square.y}` : '';
    const target = attack.targetId == null ? '' : ` target ${attack.targetId}`;
    return `${attack.actionName}${target}${aim} score ${Math.round(attack.score)}`;
  });
  const moves = (legal.moves || []).map((move) => `${move.x},${move.y}`);
  return [
    `You are ${ctx.token.name}. Catch as many enemies as you can and do not hit allies.`,
    'Choose one tool. Use only an action, square, or move listed here.',
    lines.join('\n'),
    `Legal attacks: ${attacks.join('; ') || 'none'}`,
    `Legal moves: ${moves.join('; ') || 'none'}`,
    `Dash legal: ${legal.dash ? 'yes' : 'no'}. End legal: ${legal.end ? 'yes' : 'no'}.`,
  ].join('\n');
}

async function hfComplete(payload) {
  const token = process.env.HF_TOKEN;
  if (!token) throw new Error('HF_TOKEN is not set.');
  const response = await fetch(HF_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.HF_MODEL || DEFAULT_MODEL,
      messages: payload.messages,
      tools: TOOLS,
      tool_choice: 'required',
      max_tokens: 200,
    }),
    signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) throw new Error(`Hugging Face returned ${response.status}.`);
  const data = await response.json();
  const call = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.tool_calls && data.choices[0].message.tool_calls[0];
  if (!call || !call.function) throw new Error('Hugging Face returned no tool call.');
  const args = JSON.parse(call.function.arguments || '{}');
  return Object.assign({ name: call.function.name }, args);
}

// Returns the first step. complete is a test double. Live play uses Hugging
// Face only when HF_TOKEN is set.
async function advise(ctx) {
  const legal = legalOptions(ctx);
  const complete = ctx.complete || (process.env.HF_TOKEN ? hfComplete : null);
  if (!complete) return legal.step;
  try {
    const proposal = await complete({
      messages: [
        { role: 'system', content: 'You play one monster in a tactical battle. Call exactly one tool.' },
        { role: 'user', content: battlefieldText(ctx, legal) },
      ],
    });
    return acceptProposal(proposal, legal, legal.step);
  } catch (err) {
    return legal.step;
  }
}

module.exports = { advise, acceptProposal, battlefieldText };
