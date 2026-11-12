/** the model. it only talks; `think.ts` is how each thing it says gets paid for. */
import { ask, askPaid, PATCH_MAX_PRICE, type Msg, type Paid } from './think';

const env = (k: string) => (process.env[k] || '').trim();
/** the model that plays. small and quick: it is paid for per reply, and a game is up to 25 of them. */
export const MODEL = env('MODEL') || 'google/gemini-2.5-flash-lite';
/** the model that rewrites the rules after a loss. a few calls per win, so it can be a better one. */
export const PATCH_MODEL = env('PATCH_MODEL') || 'google/gemini-3.8-flash';
/** the model behind the machine player. */
export const MACHINE_MODEL = env('MACHINE_MODEL') || MODEL;
export const MAX_TURNS = 25; // a cost ceiling per stake, never shown as a score
export const MAX_MESSAGE_CHARS = 1000;
/** a reply is a few sentences. the seller prices a call by the most it could cost, so this is also the price. */
const REPLY_TOKENS = Math.max(64, Number(env('REPLY_TOKENS')) || 240);

/** `paid` is on the ai's turns: what that reply cost the house and the payment that bought it. the model never sees it. */
export type Turn = { role: 'user' | 'agent'; text: string; paid?: Paid };
export type Purpose = 'chat' | 'machine' | 'machine-lesson' | 'test';

const toMessages = (system: string, history: Turn[]): Msg[] => [
  { role: 'system', content: system },
  ...history.map((t): Msg => ({ role: t.role === 'user' ? 'user' : 'assistant', content: t.text })),
];
const systemOf = (policy: string, preamble: string) => preamble + policy + '\n\nkeep every reply to a few sentences.';

/** one exchange under the given policy. no tools: the ai only talks. */
export async function step(policy: string, history: Turn[], userMessage: string, preamble = '', purpose: Purpose = 'chat'): Promise<Turn[]> {
  const user: Turn = { role: 'user', text: userMessage };
  const { text, paid } = await askPaid({ model: MODEL, messages: toMessages(systemOf(policy, preamble), [...history, user]), maxTokens: REPLY_TOKENS, purpose });
  return [user, { role: 'agent', text: text.trim() || '...', ...(paid ? { paid } : {}) }];
}

/** same exchange, but the reply streams: `onDelta` gets each chunk as the model produces it. */
export async function stepStream(policy: string, history: Turn[], userMessage: string, onDelta: (t: string) => void, preamble = '', purpose: Purpose = 'chat'): Promise<Turn[]> {
  const user: Turn = { role: 'user', text: userMessage };
  const { text, paid } = await askPaid({ model: MODEL, messages: toMessages(systemOf(policy, preamble), [...history, user]), maxTokens: REPLY_TOKENS, purpose, onDelta });
  return [user, { role: 'agent', text: text.trim() || '...', ...(paid ? { paid } : {}) }];
}

/** a single prompt, a single answer. the patcher, the lesson and the machine's next move all use this. */
export const say = (model: string, prompt: string, maxTokens: number, purpose: 'patch' | 'lesson' | 'machine' | 'machine-lesson', big = false) =>
  ask({ model, messages: [{ role: 'user', content: prompt }], maxTokens, purpose, ...(big ? { maxPrice: PATCH_MAX_PRICE } : {}) });

export const renderTranscript = (t: Turn[]) => t.map((x) => `${x.role === 'user' ? 'USER' : 'AI'}: ${x.text}`).join('\n');
