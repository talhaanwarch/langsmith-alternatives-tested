// Phoenix: app traffic -> user annotation -> reviewer annotation -> dataset -> judge experiment.
import { writeFileSync } from "node:fs";
import OpenAI from "openai";
import { trace } from "@opentelemetry/api";
import { register } from "@arizeai/phoenix-otel";
import { OpenAIInstrumentation } from "@arizeai/openinference-instrumentation-openai";
import { traceChain } from "@arizeai/openinference-core";
import { createClient } from "@arizeai/phoenix-client";
import { createPrompt, upsertPromptVersionTag, promptVersion } from "@arizeai/phoenix-client/prompts";
import { addSpanAnnotation, getSpans, getSpanAnnotations } from "@arizeai/phoenix-client/spans";
import { createDataset } from "@arizeai/phoenix-client/datasets";
import { runExperiment, asExperimentEvaluator } from "@arizeai/phoenix-client/experiments";
import { TRAFFIC, SYSTEM_V1, PROMPT_NAME, OR_APP_MODEL, render, isCorrect, reviewerComment, makeOpenAI } from "./fixture.js";
import { judge } from "./judge.js";

const PROJECT = "ticket-router-feedback";
const provider = register({ projectName: PROJECT, url: "http://localhost:6006" });
new OpenAIInstrumentation().manuallyInstrument(OpenAI);
const client = createClient({ options: { baseUrl: "http://localhost:6006" } });
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
const startedAt = new Date();
const out: Record<string, unknown> = { tool: "Phoenix", stamp };

// 0. The prompt lives in Phoenix prompt management, tagged production.
const pv = await createPrompt({ client, name: PROMPT_NAME, version: promptVersion({
  modelProvider: "OPENAI", modelName: OR_APP_MODEL, templateFormat: "MUSTACHE",
  template: [{ role: "system", content: SYSTEM_V1 }, { role: "user", content: "Ticket: {{ticket}}" }] }) });
await upsertPromptVersionTag({ client, prompt: { versionId: pv.id! }, name: "production" });

// 1. The app, traced. The span id is what annotations attach to.
const openai = makeOpenAI();
const route = traceChain(async (ticket: string) => {
  const r = await openai.chat.completions.create({ model: OR_APP_MODEL, temperature: 0,
    messages: [{ role: "system", content: SYSTEM_V1 }, { role: "user", content: render(ticket) }] });
  return { reply: r.choices[0].message.content ?? "", spanId: trace.getActiveSpan()!.spanContext().spanId };
}, { name: "route-ticket" });

const traffic = [];
for (const tk of TRAFFIC) {
  const { reply, spanId } = await route(tk.text);
  traffic.push({ tk, reply, spanId, correct: isCorrect(reply, tk.expected) });
}
await provider.forceFlush();
// Phoenix stores spans asynchronously; an annotation on a span it has not stored yet is a 404.
for (let i = 0; i < 30; i++) {
  const { spans } = await getSpans({ client, project: { projectName: PROJECT }, name: "route-ticket", startTime: startedAt, limit: 100 });
  if (spans.length >= TRAFFIC.length) break;
  await new Promise((r) => setTimeout(r, 1000));
}
out.trafficCorrect = traffic.filter((t) => t.correct).length;

// 2. End users press thumbs-down: a HUMAN annotation on the span.
const wrong = traffic.filter((t) => !t.correct);
for (const w of wrong) {
  await addSpanAnnotation({ client, sync: true, spanAnnotation: { spanId: w.spanId, name: "user_thumb", annotatorKind: "HUMAN", label: "down", score: 0 } });
}

// 3. Find thumbs-down spans. getSpans cannot filter by annotation, so list the spans and then read their annotations.
const { spans } = await getSpans({ client, project: { projectName: PROJECT }, name: "route-ticket", startTime: startedAt, limit: 100 });
const spanIds = spans.map((s) => s.context.span_id);
const { annotations } = await getSpanAnnotations({ client, project: { projectName: PROJECT }, spanIds, includeAnnotationNames: ["user_thumb"], limit: 100 });
const downIds = [...new Set(annotations.filter((a) => a.result?.score === 0).map((a) => a.span_id))];

// A reviewer adds a second HUMAN annotation with the correct routing as the explanation.
const bySpan = new Map(traffic.map((t) => [t.spanId, t]));
for (const id of downIds) {
  const t = bySpan.get(id)!;
  await addSpanAnnotation({ client, sync: true, spanAnnotation: { spanId: id, name: "reviewer", annotatorKind: "HUMAN", label: "wrong", score: 0, explanation: reviewerComment(t.tk, t.reply) } });
}

// 4. A dataset from the reviewed spans.
const datasetName = `ticket-router-thumbs-down-${stamp}`;
const { datasetId } = await createDataset({ client, name: datasetName, description: "Thumbs-down routings with reviewer comments",
  examples: downIds.map((id) => ({ input: { ticket: bySpan.get(id)!.tk.text },
    output: { criteria: reviewerComment(bySpan.get(id)!.tk, bySpan.get(id)!.reply) }, metadata: { source_span_id: id } })) });
out.thumbsDown = wrong.length; out.datasetExamples = downIds.length;

// 5. Judge: run v1 over the dataset with Phoenix's experiment runner and an LLM evaluator.
const experiment = await runExperiment({ client, experimentName: "v1-judge", dataset: { datasetId },
  task: async (example) => {
    const r = await makeOpenAI().chat.completions.create({ model: OR_APP_MODEL, temperature: 0,
      messages: [{ role: "system", content: SYSTEM_V1 }, { role: "user", content: render(String(example.input.ticket)) }] });
    return r.choices[0].message.content ?? "";
  },
  evaluators: [asExperimentEvaluator({ name: "matches_reviewer", kind: "LLM", evaluate: async ({ input, output, expected }) => {
    const v = await judge(String(expected?.criteria), String(input.ticket), String(output));
    return { score: v.score, label: v.score ? "match" : "no match", explanation: v.reason };
  } })],
  logger: { info: () => {}, error: console.error, log: () => {}, debug: () => {}, warn: () => {}, table: () => {} } as never,
});
const scores = Object.values(experiment.evaluationRuns ?? []).map((r) => Number(r.result?.score ?? 0));
out.judgeV1 = `${scores.reduce((a, b) => a + b, 0)}/${scores.length}`;
out.datasetName = datasetName;
console.log(out);
writeFileSync(new URL("../results/phoenix.json", import.meta.url), JSON.stringify(out, null, 2));
await provider.shutdown();
process.exit(0);
