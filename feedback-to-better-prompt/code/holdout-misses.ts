import { readFileSync } from "node:fs";
import { HOLDOUT, OR_APP_MODEL, render, isCorrect, parseLabel, makeOpenAI } from "./fixture.js";
const acrux = JSON.parse(readFileSync("../results/acruxcore.json", "utf8"));
const sys = acrux.bestCandidate.messages[0].content; const o = makeOpenAI();
for (const tk of HOLDOUT) { const r = await o.chat.completions.create({ model: OR_APP_MODEL, temperature: 0, messages: [{ role: "system", content: sys }, { role: "user", content: render(tk.text) }] });
  const reply = r.choices[0].message.content ?? ""; if (!isCorrect(reply, tk.expected)) console.log(tk.id, tk.text, "->", JSON.stringify(parseLabel(reply)), "expected", JSON.stringify(tk.expected)); }
