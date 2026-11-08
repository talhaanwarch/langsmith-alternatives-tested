// Langfuse: app traffic -> user score -> reviewer annotation queue -> dataset -> judge experiment.
import { writeFileSync } from "node:fs";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { observe, getActiveTraceId } from "@langfuse/tracing";
import { observeOpenAI } from "@langfuse/openai";
import { LangfuseClient } from "@langfuse/client";
import { TRAFFIC, SYSTEM_V1, PROMPT_NAME, OR_APP_MODEL, render, isCorrect, reviewerComment, makeOpenAI } from "./fixture.js";
import { judge } from "./judge.js";

const processor = new LangfuseSpanProcessor();
new NodeSDK({ spanProcessors: [processor] }).start();
const langfuse = new LangfuseClient();
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
const startedAt = new Date().toISOString();
const out: Record<string, unknown> = { tool: "Langfuse", stamp };

// 0. The prompt lives in Langfuse prompt management, with the production label.
await langfuse.prompt.create({ name: PROMPT_NAME, type: "chat", labels: ["production"],
  prompt: [{ role: "system", content: SYSTEM_V1 }, { role: "user", content: "Ticket: {{ticket}}" }] });

// 1. The app, traced.
const openai = observeOpenAI(makeOpenAI());
const route = observe(async (ticket: string) => {
  const r = await openai.chat.completions.create({ model: OR_APP_MODEL, temperature: 0,
    messages: [{ role: "system", content: SYSTEM_V1 }, { role: "user", content: render(ticket) }] });
  return { reply: r.choices[0].message.content ?? "", traceId: getActiveTraceId()! };
}, { name: "route-ticket" });

const traffic = [];
for (const tk of TRAFFIC) {
  const { reply, traceId } = await route(tk.text);
  traffic.push({ tk, reply, traceId, correct: isCorrect(reply, tk.expected) });
}
await processor.forceFlush();
out.trafficCorrect = traffic.filter((t) => t.correct).length;

// 2. End users press thumbs-down: a score on the trace.
const wrong = traffic.filter((t) => !t.correct);
for (const w of wrong) langfuse.score.create({ traceId: w.traceId, name: "user_thumb", value: 0, dataType: "BOOLEAN" });
await langfuse.score.flush();
await new Promise((r) => setTimeout(r, 10000)); // ingestion is asynchronous

// 3. Find thumbs-down traces by score, and put them in an annotation queue for a reviewer.
const { data: downScores } = await langfuse.api.scores.getMany({ name: "user_thumb", dataType: "BOOLEAN", value: "false", fromTimestamp: startedAt, fields: "subject", limit: 100 });
const config = await langfuse.api.scoreConfigs.create({ name: `reviewer-${stamp}`, dataType: "NUMERIC", minValue: 0, maxValue: 1 });
const queue = await langfuse.api.annotationQueues.createQueue({ name: `ticket-router-review-${stamp}`, scoreConfigIds: [config.id] });
for (const s of downScores) await langfuse.api.annotationQueues.createQueueItem(queue.id, { objectId: s.subject!.id, objectType: "TRACE" });

// The reviewer scores each queued trace and writes the correct routing as the comment.
const byTrace = new Map(traffic.map((t) => [t.traceId, t]));
for (const s of downScores) {
  const t = byTrace.get(s.subject!.id)!;
  langfuse.score.create({ traceId: t.traceId, name: `reviewer-${stamp}`, value: 0, configId: config.id, comment: reviewerComment(t.tk, t.reply) });
}
await langfuse.score.flush();

// 4. A dataset item per reviewed trace, linked back to the trace it came from.
const datasetName = `ticket-router-thumbs-down-${stamp}`;
await langfuse.api.datasets.create({ name: datasetName });
for (const s of downScores) {
  const t = byTrace.get(s.subject!.id)!;
  await langfuse.api.datasetItems.create({ datasetName, input: { ticket: t.tk.text },
    expectedOutput: { criteria: reviewerComment(t.tk, t.reply) }, sourceTraceId: t.traceId });
}
out.thumbsDown = wrong.length; out.datasetExamples = downScores.length;

// 5. Judge: run v1 over the dataset with Langfuse's experiment runner and an LLM judge evaluator.
const dataset = await langfuse.dataset.get(datasetName);
const result = await dataset.runExperiment({
  name: "v1-judge",
  task: async (item) => {
    const r = await makeOpenAI().chat.completions.create({ model: OR_APP_MODEL, temperature: 0,
      messages: [{ role: "system", content: SYSTEM_V1 }, { role: "user", content: render(String((item.input as { ticket: string }).ticket)) }] });
    return r.choices[0].message.content ?? "";
  },
  evaluators: [async ({ input, output, expectedOutput }) => {
    const v = await judge(String((expectedOutput as { criteria: string }).criteria), String((input as { ticket: string }).ticket), String(output));
    return { name: "matches_reviewer", value: v.score, comment: v.reason };
  }],
});
const scores = result.itemResults.map((r) => Number(r.evaluations[0]?.value ?? 0));
out.judgeV1 = `${scores.reduce((a, b) => a + b, 0)}/${scores.length}`;
out.datasetName = datasetName; out.queue = queue.id;
await processor.forceFlush();
console.log(out);
writeFileSync(new URL("../results/langfuse.json", import.meta.url), JSON.stringify(out, null, 2));
process.exit(0);
