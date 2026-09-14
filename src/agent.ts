import { GoogleGenAI, type Content } from '@google/genai';

export const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
export const MAX_TURNS = 8;
export const MAX_MESSAGE_CHARS = 500;

let ai: GoogleGenAI | null = null;
export function getAI() {
  if (!ai) ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY as string });
  return ai;
}

export type Turn = { role: 'user' | 'agent'; text: string };

const toContents = (history: Turn[]): Content[] =>
  history.map((t) => ({ role: t.role === 'user' ? 'user' : 'model', parts: [{ text: t.text }] }));

/** one exchange under the given policy. no tools: the ai only talks. */
export async function step(policy: string, history: Turn[], userMessage: string): Promise<Turn[]> {
  const user: Turn = { role: 'user', text: userMessage };
  const res = await getAI().models.generateContent({
    model: MODEL,
    contents: toContents([...history, user]),
    config: {
      systemInstruction: policy + '\n\nkeep every reply to a few sentences.',
      maxOutputTokens: 1024, // gemini 3 counts thinking against this budget
      thinkingConfig: { thinkingLevel: 'low' as any },
    },
  });
  return [user, { role: 'agent', text: (res.text || '').trim() || '...' }];
}

export const renderTranscript = (t: Turn[]) => t.map((x) => `${x.role === 'user' ? 'USER' : 'AI'}: ${x.text}`).join('\n');
