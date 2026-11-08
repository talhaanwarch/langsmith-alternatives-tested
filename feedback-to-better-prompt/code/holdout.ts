// The before/after check, outside every tool: run a system prompt over the 15 holdout tickets
// three times and count exact matches. Usage: npx tsx holdout.ts <file-with-system-prompt>
import { readFileSync } from "node:fs";
import { HOLDOUT, OR_APP_MODEL, render, isCorrect, makeOpenAI } from "./fixture.js";
const openai = makeOpenAI();
export async function holdoutScore(system: string, repeats = 3): Promise<number[]> {
  const scores: number[] = [];
  for (let i = 0; i < repeats; i++) {
    let ok = 0;
    for (const tk of HOLDOUT) {
      const r = await openai.chat.completions.create({ model: OR_APP_MODEL, temperature: 0,
        messages: [{ role: "system", content: system }, { role: "user", content: render(tk.text) }] });
      if (isCorrect(r.choices[0].message.content ?? "", tk.expected)) ok++;
    }
    scores.push(ok);
  }
  return scores;
}
if (process.argv[2]) console.log(await holdoutScore(readFileSync(process.argv[2], "utf8")));
