// Holdout: 15 tickets no tool ever saw. v1 against the prompt AcruxCore promoted, 3 repeats each.
import { readFileSync, writeFileSync } from "node:fs";
import { SYSTEM_V1 } from "./fixture.js";
import { holdoutScore } from "./holdout.js";
const acrux = JSON.parse(readFileSync("../results/acruxcore.json", "utf8"));
const promoted = acrux.bestCandidate.messages.find((m: { role: string }) => m.role === "system").content;
const res = { v1: await holdoutScore(SYSTEM_V1), promoted: await holdoutScore(promoted) };
console.log(res);
writeFileSync("../results/holdout.json", JSON.stringify({ ...res, promotedVersion: acrux.promotedVersion, n: 15 }, null, 2));
