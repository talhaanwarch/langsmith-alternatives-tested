# From User Feedback to a Better Prompt: code and results

Code, data and results for the SitePoint article "From User Feedback to a Better Prompt:
LangSmith, Langfuse, Phoenix and AcruxCore in TypeScript".

Each tool runs the same loop on a support-ticket router: route 15 tickets, add an end-user
thumbs-down to every wrong reply, add a reviewer comment, build a dataset, score the prompt
with an LLM judge, then rewrite the prompt where the tool can.

## Files

- `code/fixture.ts`: the prompt, the 30 tickets (15 traffic, 15 holdout), the team policy and the reviewer comments.
- `code/judge.ts`: the judge used in the LangSmith, Langfuse and Phoenix experiments.
- `code/langsmith-loop.ts`, `code/langfuse-loop.ts`, `code/phoenix-loop.ts`, `code/acruxcore-loop.ts`: one loop per tool.
- `code/langsmith-optimize.ts`: LangSmith's REST optimize job (run after `langsmith-loop.ts`; `AUTO_COMMIT=1` turns on auto-commit).
- `code/holdout-compare.ts`: the before-and-after check on the 15 holdout tickets, outside every tool (run after `acruxcore-loop.ts`).
- `code/holdout-misses.ts`: lists the holdout tickets the promoted prompt gets wrong.
- `code/baseline.ts`: sanity check of the first prompt, and of the same prompt with the policy written in.
- `results/`: the JSON each script wrote on 8 November 2026.
- `cover.png`, `01-feedback-loop.png`, `02-decision-chart.png`: the article's images. `prompts.md` has the Gemini prompts.

## Run it

```bash
cd code
npm install
cp .env.example .env   # then fill in the keys
npx tsx langsmith-loop.ts
npx tsx langsmith-optimize.ts
npx tsx langfuse-loop.ts
npx tsx phoenix-loop.ts
npx tsx acruxcore-loop.ts
npx tsx holdout-compare.ts
```

Run the scripts from the `code` folder; they write to `../results/`.

AcruxCore needs two models under Gateway → Models: `qwen3.8-flash` (upstream `qwen/qwen3.8-flash`)
and `deepseek-v4-flash` (upstream `deepseek/deepseek-v4-flash`), both through an OpenRouter connection.

## Versions used

Node 22.23. LangSmith cloud (EU). Self-hosted in Docker: Langfuse 4.76.0, Phoenix 19.18.0,
AcruxCore from `main` at commit `bf767e04`. SDKs: `langsmith` 0.11.8, `@langfuse/client` 6.1.1,
`@arizeai/phoenix-client` 7.18.2, `@acruxcoreai/sdk` 0.20.0. App model `qwen/qwen3.8-flash`;
judge and optimizer model `deepseek/deepseek-v4-flash`, all through OpenRouter.

The app model is not fully deterministic at temperature 0, so a re-run gives a slightly
different set of thumbs-down cases.
