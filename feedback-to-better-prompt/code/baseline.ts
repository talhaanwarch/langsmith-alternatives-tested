// Sanity check, no tool involved: accuracy of v1 and of a prompt that states the policy outright.

import { TRAFFIC, HOLDOUT, SYSTEM_V1, POLICY, OR_APP_MODEL, render, isCorrect, parseLabel, makeOpenAI } from "./fixture.js";
const openai = makeOpenAI();
async function route(system: string, ticket: string) {
  const r = await openai.chat.completions.create({ model: process.env.M ?? OR_APP_MODEL, temperature: 0,
    messages: [{ role: "system", content: system }, { role: "user", content: render(ticket) }] });
  return r.choices[0].message.content ?? "";
}
for (const [name, sys] of [["v1", SYSTEM_V1], ["v1+policy", SYSTEM_V1 + "\n" + POLICY]] as const) {
  for (const [setName, set] of [["traffic", TRAFFIC], ["holdout", HOLDOUT]] as const) {
    let ok = 0; const wrong: string[] = [];
    for (const tk of set) { const reply = await route(sys, tk.text); if (isCorrect(reply, tk.expected)) ok++; else { const g = parseLabel(reply); wrong.push(`${tk.id}:${g?.category}/${g?.priority}`);} }
    console.log(name, setName, `${ok}/${set.length}`, wrong.join(" "));
  }
}
