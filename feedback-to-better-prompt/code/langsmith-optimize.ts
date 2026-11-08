// LangSmith's optimizer: a server-side "optimize job" (algorithm promptim) on the hub prompt.
// No TypeScript SDK method wraps it, so this calls the REST API listed in LangSmith's API reference.
import { readFileSync, writeFileSync } from "node:fs";
import "./fixture.js";

const api = process.env.LANGSMITH_ENDPOINT!;
const H = { "x-api-key": process.env.LANGSMITH_API_KEY!, "Content-Type": "application/json" };
const state = JSON.parse(readFileSync("../results/langsmith.json", "utf8"));
const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${api}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 400)}`);
  return JSON.parse(text);
};

// An evaluator the job can score with: does the reply name the category and priority the reviewer gave?
const evaluator = await call("POST", "/api/v1/platform/evaluators", {
  name: `matches-reviewer-${state.stamp}`, type: "code",
  code_evaluator: { language: "python", code: `
import re, json
def perform_eval(run, example):
    crit = str((example.get("outputs") or {}).get("criteria", ""))
    m = re.search(r"category (\\w+), priority (P\\d)", crit)
    text = re.sub(r"\\s+", "", json.dumps(run.get("outputs")))
    ok = bool(m) and ('\\\\"category\\\\":\\\\"%s\\\\"' % m.group(1)) in text and ('\\\\"priority\\\\":\\\\"%s\\\\"' % m.group(2)) in text
    return {"matches_reviewer": 1 if ok else 0}
` } });
console.log("evaluator", JSON.stringify(evaluator).slice(0, 300));
const evaluatorId = evaluator.id ?? evaluator.evaluator?.id;

const job = await call("POST", "/api/v1/repos/optimize-job", {
  algorithm: "promptim", prompt_name: "ticket-router",
  config: { message_index: 0, task_description: "Route support tickets for Acme into a category and a priority.",
    dataset_name: state.datasetName, train_split: null, dev_split: null, test_split: null,
    evaluators: [evaluatorId], num_epochs: 3, auto_commit: process.env.AUTO_COMMIT === "1" } });
const id = job.optimization_job_id;
let j;
do { await new Promise((r) => setTimeout(r, 5000)); j = await call("GET", `/api/v1/repos/-/ticket-router/optimization-jobs/${id}`); }
while (j.status === "created" || j.status === "running");
const logs = await call("GET", `/api/v1/repos/-/ticket-router/optimization-jobs/${id}/logs`);
console.log(j.status, JSON.stringify(j.results));
for (const l of logs.reverse()) console.log(l.log_type, l.message, JSON.stringify(l.data).slice(0, 1500));
// Drop the account email and workspace id before saving.
const scrub = (_k: string, v: unknown) => (_k === "created_by" || _k === "tenant_id" ? undefined : v);
writeFileSync(`../results/langsmith-optimize${process.env.AUTO_COMMIT === "1" ? "-autocommit" : ""}.json`, JSON.stringify({ evaluator, job: j, logs }, scrub, 2));
