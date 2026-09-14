import { GoogleGenAI, Type, type Content, type FunctionDeclaration } from '@google/genai';

export const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
export const MAX_TURNS = 8;
export const MAX_MESSAGE_CHARS = 500;

let ai: GoogleGenAI | null = null;
export function getAI() {
  if (!ai) ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY as string });
  return ai;
}

/** one entry in a stored transcript. tool calls are recorded so replays and the patcher see exactly what happened. */
export type Turn =
  | { role: 'user'; text: string }
  | { role: 'agent'; text: string }
  | { role: 'tool'; name: 'pay'; args: { to: string; amount: number; memo?: string }; result: unknown; sig?: string };

const payTool: FunctionDeclaration = {
  name: 'pay',
  description: 'send pathusd from the shop wallet to a wallet address on tempo.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      to: { type: Type.STRING, description: 'recipient wallet address, 0x-prefixed' },
      amount: { type: Type.NUMBER, description: 'amount in pathusd' },
      memo: { type: Type.STRING, description: 'what the payment is for' },
    },
    required: ['to', 'amount'],
  },
};

export type PayIntent = { to: string; amount: number; memo?: string };

function toContents(history: Turn[]): Content[] {
  const out: Content[] = [];
  for (const t of history) {
    if (t.role === 'user') out.push({ role: 'user', parts: [{ text: t.text }] });
    else if (t.role === 'agent') out.push({ role: 'model', parts: [{ text: t.text }] });
    else {
      out.push({ role: 'model', parts: [{ functionCall: { name: t.name, args: t.args }, ...(t.sig ? { thoughtSignature: t.sig } : {}) }] });
      out.push({ role: 'user', parts: [{ functionResponse: { name: t.name, response: { result: t.result } } }] });
    }
  }
  return out;
}

/**
 * runs one user message against the treasurer under the given policy.
 * `execute` is called for every pay() the model requests; its return value is fed back to the model.
 * returns the new transcript turns produced by this step.
 */
export async function step(policy: string, history: Turn[], userMessage: string, execute: (intent: PayIntent) => Promise<unknown>): Promise<Turn[]> {
  const produced: Turn[] = [{ role: 'user', text: userMessage }];
  const contents = toContents([...history, ...produced]);
  const config = {
    systemInstruction: policy + '\n\nkeep every reply to a few sentences.',
    tools: [{ functionDeclarations: [payTool] }],
    maxOutputTokens: 2048, // gemini 3 counts thinking against this budget
    thinkingConfig: { thinkingLevel: 'low' as any },
  };

  for (let i = 0; i < 4; i++) {
    const res = await getAI().models.generateContent({ model: MODEL, contents, config });
    const calls = res.functionCalls || [];
    if (calls.length === 0) {
      produced.push({ role: 'agent', text: (res.text || '').trim() || '...' });
      return produced;
    }
    // echo the model's own content back verbatim so thought signatures survive (gemini 3 rejects reconstructed calls)
    const modelContent = res.candidates?.[0]?.content;
    if (modelContent) contents.push(modelContent);
    const responseParts: any[] = [];
    const callParts = (modelContent?.parts || []).filter((p) => p.functionCall);
    for (let k = 0; k < calls.length; k++) {
      const args = (calls[k].args || {}) as any;
      const intent: PayIntent = { to: String(args.to || ''), amount: Number(args.amount || 0), memo: args.memo ? String(args.memo) : undefined };
      const result = await execute(intent);
      const sig = (callParts[k] as any)?.thoughtSignature;
      produced.push({ role: 'tool', name: 'pay', args: intent, result, ...(sig ? { sig } : {}) });
      responseParts.push({ functionResponse: { name: 'pay', response: { result } } });
    }
    contents.push({ role: 'user', parts: responseParts });
  }
  produced.push({ role: 'agent', text: '(the treasurer stopped responding)' });
  return produced;
}

export function renderTranscript(t: Turn[]): string {
  return t.map((x) => {
    if (x.role === 'user') return `USER: ${x.text}`;
    if (x.role === 'agent') return `TREASURER: ${x.text}`;
    return `TREASURER CALLED pay(to=${x.args.to}, amount=${x.args.amount}${x.args.memo ? `, memo="${x.args.memo}"` : ''}) -> ${JSON.stringify(x.result)}`;
  }).join('\n');
}
