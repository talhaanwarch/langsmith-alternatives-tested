# Self-hosting Langfuse vs lighter alternatives, measured

Code, raw results and images for the article "Self-Hosting Langfuse vs Lighter Alternatives:
Memory, Disk and Speed at 100,000 Traces".

Five tools, each from its own official Docker Compose file, on one machine (24 cores, 62 GiB,
NVMe, Docker 29.9.2), November 2026:

| Tool | Version |
|---|---|
| Langfuse | 4.79.0 |
| Arize Phoenix | 21.0.0 |
| MLflow | 3.18.0 |
| AcruxCore | built from commit `241f233` of the AcruxCore repo |
| Opik | 2.2.143 |

## What is here

- `code/load.py`: the load generator. It sends synthetic 3-span agent traces over OTLP/HTTP from
  4 processes, in synchronous batches of 100 traces, and retries a rejected batch for up to
  10 minutes, so no trace is dropped on the client side.
- `code/bench.py`: `full <tool>` boots the stack three times, records idle memory and disk,
  sends 10,000 then 90,000 traces, waits 10 minutes after each batch, records memory and disk
  again, and times two API calls. `cap <tool> <GB> <CPUs>` runs a fresh stack inside a hard
  memory and CPU limit and sends 10,000 traces.
- `code/compose.sh` and `code/overrides/`: the exact Compose command per tool. The overrides
  change only host ports, a fixed subnet, the version, and the login settings a script needs.
- `code/summarize.py`: prints the article's tables from `results/`. Its output is in
  `results/SUMMARY.md`.
- `results/*.jsonl`: every reading, one JSON line each. `*.samples.jsonl` holds every
  `docker stats` sample taken during ingest.

AcruxCore's tables use the files ending in `-851` (the build named above). The AcruxCore files
without that suffix measured an earlier published image and are not used in the article.

## Run it

```bash
pip install opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
git clone --depth 1 https://github.com/langfuse/langfuse  $UP/langfuse
git clone --depth 1 https://github.com/Arize-ai/phoenix   $UP/phoenix
git clone --depth 1 https://github.com/mlflow/mlflow      $UP/mlflow
git clone --depth 1 https://github.com/comet-ml/opik      $UP/opik
git clone --depth 1 https://github.com/AcruxCore/AcruxCore $REPO
cd code
UP=$UP REPO=$REPO PY=$(which python) python bench.py full langfuse
UP=$UP REPO=$REPO PY=$(which python) python bench.py cap phoenix 2 1
python summarize.py
```

The capped runs create a systemd slice per run, so they need a Linux host with systemd and
cgroup v2.
