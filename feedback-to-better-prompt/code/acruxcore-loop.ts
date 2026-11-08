// AcruxCore: app traffic -> end-user thumbs -> reviewer comments -> dataset -> judge + optimizer -> promote.
import { writeFileSync } from "node:fs";
import { acruxcore } from "@acruxcoreai/sdk";
import { TRAFFIC, SYSTEM_V1, PROMPT_NAME, APP_MODEL, JUDGE_MODEL, isCorrect, reviewerComment } from "./fixture.js";

const hub = new acruxcore({ apiKey: process.env.ACRUXCORE_API_KEY, baseUrl: process.env.ACRUXCORE_BASE_URL, cacheTtl: 0 });
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
const out: Record<string, unknown> = { tool: "AcruxCore", stamp };

// 0. The prompt, with v1 on production.
const { data } = await hub.prompts.list({ search: PROMPT_NAME });
const promptId = data.find((p) => p.name === PROMPT_NAME)?.id ?? (await hub.prompts.create({ name: PROMPT_NAME })).id;
const v1 = await hub.prompts.commitVersion(promptId, { messages: [{ role: "system", content: SYSTEM_V1 }, { role: "user", content: "Ticket: {{ticket}}" }] });
await hub.prompts.promoteAlias(promptId, "production", v1.versionNumber);
out.v1Version = v1.versionNumber;

// 1. The app: render production, call the model through the gateway, which records the trace.
async function route(ticket: string) {
  const p = await hub.prompts.render(PROMPT_NAME, "production", { ticket });
  const r = await hub.gateway.chat({ model: APP_MODEL, messages: p.messages, temperature: 0,
    promptVersionId: p.versionId ?? undefined, variables: { ticket } });
  return { reply: r.content ?? "", traceId: r.gateway.traceId! };
}
const traffic = [];
for (const tk of TRAFFIC) {
  const { reply, traceId } = await route(tk.text);
  traffic.push({ tk, reply, traceId, correct: isCorrect(reply, tk.expected) });
}
out.trafficCorrect = traffic.filter((t) => t.correct).length;

// 2. End users press thumbs-down in the app.
const wrong = traffic.filter((t) => !t.correct);
for (const w of wrong) await hub.traces.submitFeedback({ traceId: w.traceId, rating: -1, source: "end_user" });

// 3. A reviewer lists thumbs-down feedback on this prompt and adds a comment with the correct routing.
const { data: downs } = await hub.traces.listFeedback({ rating: "down", promptId, limit: 100 });
const byTrace = new Map(traffic.map((t) => [t.traceId, t]));
const reviewerIds: string[] = [];
for (const f of downs.filter((f) => f.source === "end_user" && byTrace.has(f.traceId))) {
  const t = byTrace.get(f.traceId)!;
  const fb = await hub.traces.submitFeedback({ traceId: t.traceId, rating: -1, comment: reviewerComment(t.tk, t.reply), source: "user" });
  reviewerIds.push(fb.id);
}

// 4. A dataset from the reviewer's feedback: each comment becomes that example's grading criteria.
const dataset = await hub.datasets.buildFromFeedback({ name: `ticket-router-thumbs-down-${stamp}`, feedbackIds: reviewerIds });
out.thumbsDown = wrong.length; out.datasetExamples = dataset.exampleCount ?? (dataset as unknown as { example_count: number }).example_count;
out.skipped = dataset.skipped;

// 5 + 6. Judge and optimizer in one run: three rewrites of production, each scored with production on every example.
const run = await hub.optimize.start(promptId, { datasetId: dataset.id, models: [APP_MODEL], judgeModel: JUDGE_MODEL, optimizerModel: JUDGE_MODEL, draftCount: 3 });
let detail;
do { await new Promise((r) => setTimeout(r, 5000)); detail = await hub.runs.get(run.runId); } while (["queued", "running"].includes(detail.status));
out.runStatus = detail.status; out.runError = detail.error;
const report = await hub.runs.getReport(run.runId);
out.cells = report.cells.map((c) => ({ variant: c.variantLabel, baseline: c.isProductionBaseline, passRate: c.passRate, avgScore: c.avgScore, scored: c.scoredCount, n: c.exampleCount }));
const best = report.cells.filter((c) => !c.isProductionBaseline).sort((a, b) => (b.avgScore ?? -1) - (a.avgScore ?? -1))[0];
const cell = detail.grid.find((g) => g.cellKey === best.cellKey)!;
const candidate = await hub.runs.getCandidate(run.runId, cell.promptCandidateId!);
out.bestCandidate = { label: candidate.label, rationale: candidate.rationale, messages: candidate.messages };

// 7. Promote the winner. Only the production alias moves.
const promoted = await hub.runs.promoteCandidate(run.runId, { promptCandidateId: cell.promptCandidateId!, alias: "production" });
out.promotedVersion = promoted.version.versionNumber;
out.runId = run.runId; out.promptId = promptId; out.datasetId = dataset.id;
console.log(JSON.stringify(out, null, 2));
writeFileSync(new URL("../results/acruxcore.json", import.meta.url), JSON.stringify(out, null, 2));
await hub.gateway.flush?.();
process.exit(0);
