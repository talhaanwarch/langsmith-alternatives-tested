// Shared test data: one ticket-router prompt, 30 tickets, and the team's routing policy.
// "traffic" tickets are what the app sees in production; "holdout" tickets are never shown
// to any optimizer and are used only for the before/after accuracy check.
import { existsSync } from "node:fs";
// Keys come from the environment, or from a .env file next to this script (see .env.example).
const envFile = new URL("./.env", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile); // never overrides values already set

export type Category = "account" | "billing" | "bug" | "feature_request";
export type Priority = "P0" | "P1" | "P2";
export interface Label { category: Category; priority: Priority }
export interface Ticket { id: string; text: string; expected: Label; rule: string }

export const APP_MODEL = "qwen3.8-flash";
export const JUDGE_MODEL = "deepseek-v4-flash";

export const PROMPT_NAME = "ticket-router";
export const SYSTEM_V1 =
  "You route support tickets for Acme, a project management app.\n" +
  'Reply with JSON only, in this shape: {"category": "account" | "billing" | "bug" | "feature_request", "priority": "P0" | "P1" | "P2"}.';
export const USER_TEMPLATE = "Ticket: {{ticket}}";

// What the support team knows and the prompt does not say.
export const POLICY =
  "Route by our policy, not by the customer's tone. Sign-in, passwords, 2FA, SSO and profile settings " +
  "are always category account. Priority is about impact: P0 when the customer or their team cannot use " +
  "the product at all, or has lost data; P1 when money is wrong (double charges, wrong amounts, refunds, " +
  "invoice errors), even if they say it is not urgent; P2 for everything else, including feature requests " +
  "and bugs with a workaround, however upset or urgent the customer sounds.";

const RULES: Record<string, string> = {
  auth: "Sign-in, passwords, 2FA, SSO and profile settings are always account for us.",
  lockout: "A customer or team that cannot get into the product at all is P0.",
  money: "Any billing error is P1, even when the customer says there is no rush.",
  tone: "Feature requests are P2 however angry or urgent the customer sounds.",
  workaround: "A bug with a workaround is P2.",
  dataloss: "Lost data is P0.",
  outage: "Nobody on the team can work, so P0.",
  settings: "A profile setting question is account, P2, even when written in capitals.",
};

const t = (id: string, text: string, category: Category, priority: Priority, rule: string): Ticket =>
  ({ id, text, expected: { category, priority }, rule });

export const TRAFFIC: Ticket[] = [
  t("T01", "I can't sign in. The password reset email never arrives and I'm locked out of my workspace.", "account", "P0", "lockout"),
  t("T02", "Hi! Small thing, no rush at all: we were charged twice this month, $49 each. Whenever you get a chance.", "billing", "P1", "money"),
  t("T03", "This is REALLY frustrating. Your app has no dark mode. Add it ASAP!!!", "feature_request", "P2", "tone"),
  t("T04", "Our whole team gets a 500 error on every page since this morning. Nobody can work.", "bug", "P0", "outage"),
  t("T05", "2FA codes from my authenticator app are rejected, so I can't get into my account at all.", "account", "P0", "lockout"),
  t("T06", "The CSV export puts dates in the wrong column. I can fix it by hand in Excel for now.", "bug", "P2", "workaround"),
  t("T07", "Can you add a Gantt chart view? It would really help our planning.", "feature_request", "P2", "tone"),
  t("T08", "You billed us for 12 seats but we only have 9 users. Not urgent, just flagging.", "billing", "P1", "money"),
  t("T09", "URGENT!!! I want to change the colour of my profile avatar and can't find where.", "account", "P2", "settings"),
  t("T10", "SSO login with Okta fails with 'invalid audience' for all 40 of our users.", "account", "P0", "auth"),
  t("T11", "The mobile app crashes when I open a task with an attachment. The web app works fine.", "bug", "P2", "workaround"),
  t("T12", "Please refund last month's charge; we cancelled before the renewal date.", "billing", "P1", "money"),
  t("T13", "Comments disappear after I save them. I've lost an hour of review notes.", "bug", "P0", "dataloss"),
  t("T14", "Would love an API endpoint for archiving projects. Sorry to bother you, totally optional!", "feature_request", "P2", "tone"),
  t("T15", "The invoice shows the wrong VAT number for our company.", "billing", "P1", "money"),
];

export const HOLDOUT: Ticket[] = [
  t("H01", "Locked out after changing my email address. Login says the account doesn't exist.", "account", "P0", "lockout"),
  t("H02", "Just a heads up whenever convenient: the annual plan on my invoice is $20 higher than the pricing page.", "billing", "P1", "money"),
  t("H03", "I'm so angry. Why can't I set recurring tasks?? This is basic. Fix it NOW.", "feature_request", "P2", "tone"),
  t("H04", "The board view won't load for anyone in our org, just a spinner. Total blocker.", "bug", "P0", "outage"),
  t("H05", "The password reset link says 'expired' even when I click it right away, and I can't log in without it.", "account", "P0", "lockout"),
  t("H06", "Search results are sorted oddly, but filtering by date works as a workaround.", "bug", "P2", "workaround"),
  t("H07", "Could you support Markdown tables in task descriptions?", "feature_request", "P2", "tone"),
  t("H08", "We were charged for the Pro plan after downgrading to Free last week. No hurry.", "billing", "P1", "money"),
  t("H09", "!!! HELP !!! How do I change my display name?", "account", "P2", "settings"),
  t("H10", "The Google sign-in button does nothing for everyone at our company since the update.", "account", "P0", "auth"),
  t("H11", "Notifications arrive twice. Annoying, but I can live with it.", "bug", "P2", "workaround"),
  t("H12", "I need a refund for the duplicate seat we added by mistake yesterday.", "billing", "P1", "money"),
  t("H13", "Uploaded files are gone from three projects. We need them for a client deliverable today.", "bug", "P0", "dataloss"),
  t("H14", "Feature idea, no pressure: a keyboard shortcut to create tasks.", "feature_request", "P2", "tone"),
  t("H15", "Our receipt lists the wrong company address.", "billing", "P1", "money"),
];

/** Parses the model's reply; returns null when it is not the JSON shape we asked for. */
export function parseLabel(reply: string): Label | null {
  const m = reply.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    return typeof o.category === "string" && typeof o.priority === "string" ? o : null;
  } catch { return null; }
}

export const isCorrect = (reply: string, expected: Label) => {
  const got = parseLabel(reply);
  return !!got && got.category === expected.category && got.priority === expected.priority;
};

/** The reviewer's comment: what was wrong, the rule, and the correct answer. */
export function reviewerComment(tk: Ticket, reply: string): string {
  const got = parseLabel(reply);
  const what = got ? `The router said ${got.category} / ${got.priority}.` : "The reply was not valid JSON.";
  return `Wrong. ${what} ${RULES[tk.rule]} Correct answer: category ${tk.expected.category}, priority ${tk.expected.priority}.`;
}

export const render = (ticket: string) => USER_TEMPLATE.replace("{{ticket}}", ticket);

/** Every direct model call goes through OpenRouter (an OpenAI-compatible API). */
import OpenAI from "openai";
export const makeOpenAI = () =>
  new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey: process.env.OPENROUTER_KEY });
export const OR_APP_MODEL = "qwen/qwen3.8-flash";
export const OR_JUDGE_MODEL = "deepseek/deepseek-v4-flash";
