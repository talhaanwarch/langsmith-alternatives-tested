// The judge every tool's experiment uses, except AcruxCore, which runs its built-in judge.
// It grades one reply against the reviewer's comment, so the comment is the rubric.
import { makeOpenAI, OR_JUDGE_MODEL } from "./fixture.js";

const openai = makeOpenAI();
export const JUDGE_PROMPT = `You grade a support-ticket router.
A reviewer wrote what the correct routing is for this ticket. Decide whether the router's reply matches it.
Reviewer comment: {{criteria}}
Ticket: {{ticket}}
Router reply: {{reply}}
Answer with JSON only: {"score": 1 or 0, "reason": "<one sentence>"}`;

export async function judge(criteria: string, ticket: string, reply: string): Promise<{ score: number; reason: string }> {
  const content = JUDGE_PROMPT.replace("{{criteria}}", criteria).replace("{{ticket}}", ticket).replace("{{reply}}", reply);
  const r = await openai.chat.completions.create({ model: OR_JUDGE_MODEL, temperature: 0, messages: [{ role: "user", content }] });
  const text = r.choices[0].message.content ?? "";
  const m = text.match(/\{[\s\S]*\}/);
  try { const o = JSON.parse(m![0]); return { score: Number(o.score) ? 1 : 0, reason: String(o.reason) }; }
  catch { return { score: 0, reason: `unparseable judge reply: ${text.slice(0, 80)}` }; }
}
