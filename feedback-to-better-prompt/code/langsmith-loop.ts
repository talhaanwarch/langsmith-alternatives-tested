// LangSmith: app traffic -> user feedback -> reviewer queue -> dataset -> judge experiment.
// The optimizer step is probed separately in langsmith-optimize.ts.
import { writeFileSync } from "node:fs";
import { Client } from "langsmith";
import { traceable, getCurrentRunTree } from "langsmith/traceable";
import { wrapOpenAI } from "langsmith/wrappers";
import { evaluate } from "langsmith/evaluation";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { TRAFFIC, SYSTEM_V1, PROMPT_NAME, OR_APP_MODEL, render, isCorrect, reviewerComment, makeOpenAI } from "./fixture.js";
import { judge } from "./judge.js";

process.env.LANGSMITH_TRACING = "true";
const PROJECT = "ticket-router-feedback";
const client = new Client({ apiUrl: process.env.LANGSMITH_ENDPOINT, apiKey: process.env.LANGSMITH_API_KEY });
const openai = wrapOpenAI(makeOpenAI());
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
const out: Record<string, unknown> = { tool: "LangSmith", stamp };
const startedAt = new Date().toISOString();

// 0. The prompt lives in LangSmith's prompt hub, so an optimizer can find it by name.
const prompt = ChatPromptTemplate.fromMessages([["system", SYSTEM_V1], ["human", "Ticket: {{ticket}}"]], { templateFormat: "mustache" });
if (await client.promptExists(PROMPT_NAME)) await client.createCommit(PROMPT_NAME, prompt).catch((e) => { if (e.status !== 409) throw e; }); // 409 = unchanged
else await client.pushPrompt(PROMPT_NAME, { object: prompt });

// 1. The app. One traced function per ticket.
const route = traceable(async (ticket: string) => {
  const r = await openai.chat.completions.create({ model: OR_APP_MODEL, temperature: 0,
    messages: [{ role: "system", content: SYSTEM_V1 }, { role: "user", content: render(ticket) }] });
  return { reply: r.choices[0].message.content ?? "", runId: getCurrentRunTree().id };
}, { name: "route-ticket", project_name: PROJECT, client });

const traffic = [];
for (const tk of TRAFFIC) {
  const { reply, runId } = await route(tk.text);
  traffic.push({ tk, reply, runId, correct: isCorrect(reply, tk.expected) });
}
await client.awaitPendingTraceBatches();
await new Promise((r) => setTimeout(r, 5000));
const project = await client.readProject({ projectName: PROJECT });
out.trafficCorrect = traffic.filter((t) => t.correct).length;

// 2. End users press thumbs-down on the wrong answers.
const wrong = traffic.filter((t) => !t.correct);
for (const w of wrong) {
  await client.createFeedback(w.runId, "user_thumb", { score: 0, sessionId: project.id, traceId: w.runId, feedbackSourceType: "app" });
}

await new Promise((r) => setTimeout(r, 8000)); // feedback is written in the background

// 3. Find the thumbs-down runs with LangSmith's run query, and send them to an annotation queue.
const thumbsDown: { id: string; start_time: string }[] = [];
for await (const run of client.runs.queryV2({ project_ids: [project.id], is_root: true, min_start_time: startedAt,
  filter: 'and(eq(feedback_key, "user_thumb"), eq(feedback_score, 0))', selects: ["ID", "INPUTS", "START_TIME"] }))
  thumbsDown.push({ id: run.id!, start_time: run.start_time! });
const queue = await client.createAnnotationQueue({ name: `ticket-router-review-${stamp}`, description: "Thumbs-down routings" });
await client.addRunsToAnnotationQueue(queue.id,
  thumbsDown.map((r) => ({ runId: r.id, sessionId: project.id, startTime: r.start_time })));

// A reviewer works through the queue and writes the correct routing as a comment.
const byRun = new Map(traffic.map((t) => [t.runId, t]));
for (const r of thumbsDown) {
  const t = byRun.get(r.id)!;
  await client.createFeedback(r.id, "reviewer", { score: 0, comment: reviewerComment(t.tk, t.reply), sessionId: project.id, traceId: r.id });
}

// 4. Build a dataset from the reviewed runs: the ticket as input, the reviewer's comment as the reference.
const ds = await client.createDataset(`ticket-router-thumbs-down-${stamp}`);
await client.createExamples({ datasetId: ds.id, sourceRunIds: thumbsDown.map((r) => r.id),
  inputs: thumbsDown.map((r) => ({ ticket: byRun.get(r.id)!.tk.text })),
  referenceOutputs: thumbsDown.map((r) => ({ criteria: reviewerComment(byRun.get(r.id)!.tk, byRun.get(r.id)!.reply) })) });
out.datasetExamples = thumbsDown.length;
out.thumbsDown = wrong.length;

// 5. Judge: run the current prompt over the dataset and grade each reply against the reviewer's comment.
const results = await evaluate(
  async (inputs: { ticket: string }) => {
    const r = await makeOpenAI().chat.completions.create({ model: OR_APP_MODEL, temperature: 0,
      messages: [{ role: "system", content: SYSTEM_V1 }, { role: "user", content: render(inputs.ticket) }] });
    return { reply: r.choices[0].message.content ?? "" };
  },
  { data: ds.name, experimentPrefix: "v1-judge", client,
    evaluators: [async ({ inputs, outputs, referenceOutputs }: { inputs: Record<string, unknown>; outputs: Record<string, unknown>; referenceOutputs?: Record<string, unknown> }) => {
      const v = await judge(String(referenceOutputs?.criteria), String(inputs.ticket), String(outputs.reply));
      return { key: "matches_reviewer", score: v.score, comment: v.reason };
    }] });
const scores: number[] = [];
for (const row of results.results) scores.push(Number(row.evaluationResults.results[0]?.score ?? 0));
out.judgeV1 = `${scores.reduce((a, b) => a + b, 0)}/${scores.length}`;
out.datasetName = ds.name; out.queue = queue.id;
console.log(out);
writeFileSync(new URL("../results/langsmith.json", import.meta.url), JSON.stringify(out, null, 2));
