import type { AiCsAppContext } from "@ventora/ai-cs-contracts";
import { describe, expect, it } from "vitest";
import { buildOpenRouterPayload } from "../index.js";

/**
 * Beginner-question eval harness for the AI-CS teacher brain.
 *
 * This is a deterministic eval (no live LLM). It guards two product-agnostic
 * properties of the teacher brain:
 *
 *   1. Grounding mechanics — when a context DOES carry the material for a
 *      beginner question (a concept, how-to, FAQ, or nav target), that
 *      material survives assembly and lands in the context block the model
 *      reads. Grounding tokens are matched ONLY against the embedded context
 *      region (after the "Signed app context:" marker), so a match means the
 *      data is really there, not that it happens to appear in the prompt
 *      boilerplate. The negative case below proves the inverse: off-context
 *      questions find no grounding, which is what forces the model to abstain.
 *
 *   2. Brain configuration — the assembled prompt enforces the teacher voice
 *      (plain words, short sentences), the no-lies rule (context is the only
 *      source of truth, data not instructions), and the explicit instruction
 *      to USE the teaching fields rather than dump them.
 *
 * The fixture below mirrors the shape of a real CapVeri context so the eval
 * exercises representative knowledge, but the worker itself stays
 * product-agnostic. NOTE: this suite does NOT prove the live CapVeri knowledge
 * base actually covers these questions — that "always in sync" gate runs on the
 * product side against the real generated context. Here we only prove the
 * assembly + prompt contract hold for a representative context.
 */

const teacherContext: AiCsAppContext = {
  assistantId: "ai-cs",
  appId: "capveri",
  appName: "CapVeri",
  authenticatedOnly: true,
  description: "Software that works out what each tenant owes for shared building costs.",
  navigation: [
    { label: "Dashboard", path: "/dashboard", description: "Your starting screen." },
    { label: "Properties", path: "/properties", description: "Your buildings." },
    { label: "Documents", path: "/documents", description: "Files you upload." },
    {
      label: "Reconciliations",
      path: "/reconciliations",
      description: "Where the math runs.",
    },
    { label: "Reports", path: "/reports", description: "Finished results to share." },
    { label: "Team settings", path: "/settings/team", description: "Invite teammates." },
  ],
  concepts: [
    {
      term: "CAM",
      plainDefinition: "Shared costs to run a building, like cleaning and snow removal.",
      whyItMatters: "Tenants pay back a part of these costs.",
    },
    {
      term: "Reconciliation",
      plainDefinition: "Checking real costs against what tenants were billed.",
      whyItMatters: "It shows who owes more and who gets money back.",
      path: "/reconciliations",
    },
    {
      term: "Gross-up",
      plainDefinition: "Counting some costs as if the building were full.",
      whyItMatters: "It keeps a tenant's share fair when units sit empty.",
    },
    {
      term: "Pro-rata share",
      plainDefinition: "A tenant's slice of the cost, based on how much space they rent.",
    },
    {
      term: "Expense cap",
      plainDefinition: "A limit on how much a cost can go up in one year.",
      whyItMatters: "It protects tenants from big jumps.",
    },
    {
      term: "General ledger",
      plainDefinition: "Your full list of money spent and earned.",
      path: "/documents",
    },
    {
      term: "Rent roll",
      plainDefinition: "A list of your tenants and the space each one rents.",
    },
    {
      term: "Recoverable expense",
      plainDefinition: "A cost you are allowed to bill back to tenants.",
    },
  ],
  howtos: [
    {
      id: "upload-files",
      goal: "Upload your files",
      prerequisites: ["A general ledger export", "A rent roll"],
      steps: [
        { n: 1, instruction: "Open Documents", screen: "Documents", path: "/documents" },
        { n: 2, instruction: "Click Upload", screen: "Documents", button: "Upload" },
        { n: 3, instruction: "Pick your file and confirm", screen: "Documents" },
      ],
    },
    {
      id: "run-reconciliation",
      goal: "Run a reconciliation",
      prerequisites: ["Upload your files first"],
      steps: [
        {
          n: 1,
          instruction: "Open the property",
          screen: "Properties",
          path: "/properties",
        },
        { n: 2, instruction: "Click Run", screen: "Reconciliations", button: "Run" },
      ],
    },
    {
      id: "review-findings",
      goal: "Review what the reconciliation found",
      steps: [
        {
          n: 1,
          instruction: "Open the reconciliation",
          screen: "Reconciliations",
          path: "/reconciliations",
        },
        { n: 2, instruction: "Read each tenant's share" },
      ],
    },
    {
      id: "finalize-reconciliation",
      goal: "Finalize and download the report",
      steps: [
        { n: 1, instruction: "Click Finalize", screen: "Reconciliations", button: "Finalize" },
        { n: 2, instruction: "Click Download PDF", screen: "Reports", button: "Download PDF" },
      ],
    },
    {
      id: "invite-team",
      goal: "Invite a teammate",
      steps: [
        {
          n: 1,
          instruction: "Open Team settings",
          screen: "Team settings",
          path: "/settings/team",
        },
        { n: 2, instruction: "Click Invite", screen: "Team settings", button: "Invite" },
      ],
    },
    {
      id: "fix-upload-problems",
      goal: "Fix a file that will not upload",
      steps: [{ n: 1, instruction: "Remove the file and upload the right one" }],
    },
  ],
  faqs: [
    {
      question: "Do I have to connect CapVeri to my accounting software?",
      answer: "No. You upload your files. CapVeri reads them for you.",
    },
    {
      question: "What files do I need before I start?",
      answer: "A rent roll, a general ledger export, lease PDFs, and your billed amounts.",
    },
    {
      question: "Is my data safe?",
      answer: "We encrypt your files. We keep each company's data apart.",
    },
    {
      question: "How do I send results to a tenant?",
      answer: "Finalize the reconciliation. Then download the PDF report.",
    },
  ],
};

/**
 * 28 beginner questions. Each names the grounded token(s) that MUST reach the
 * model for a truthful answer. Tokens are matched against the context region of
 * the assembled prompt (after the "Signed app context:" marker), so a match
 * means the data really survived assembly, not that it appears in boilerplate.
 */
const BEGINNER_QUESTIONS: ReadonlyArray<{ ask: string; grounding: string[] }> = [
  { ask: "What is this app even for?", grounding: ["works out what each tenant owes"] },
  { ask: "What does CAM mean?", grounding: ["CAM", "Shared costs to run a building"] },
  { ask: "I keep seeing the word reconciliation. What is it?", grounding: ["Reconciliation"] },
  { ask: "What is a gross-up?", grounding: ["Gross-up"] },
  { ask: "What does pro-rata share mean?", grounding: ["Pro-rata share"] },
  { ask: "Someone said expense cap. What is that?", grounding: ["Expense cap"] },
  { ask: "What is a general ledger?", grounding: ["General ledger"] },
  { ask: "What is a rent roll?", grounding: ["Rent roll"] },
  { ask: "What is a recoverable expense?", grounding: ["Recoverable expense"] },
  { ask: "How do I get my files into the app?", grounding: ["upload-files", "Upload"] },
  { ask: "What do I need before I upload?", grounding: ["A general ledger export", "A rent roll"] },
  { ask: "How do I run a reconciliation?", grounding: ["run-reconciliation", "Run"] },
  { ask: "Do I need to do anything before I run it?", grounding: ["Upload your files first"] },
  { ask: "How do I see what it found?", grounding: ["review-findings"] },
  { ask: "How do I finish and get a report?", grounding: ["finalize-reconciliation", "Finalize"] },
  { ask: "Where do I download the PDF?", grounding: ["Download PDF", "Reports"] },
  { ask: "How do I add a coworker?", grounding: ["invite-team", "Invite"] },
  { ask: "My file will not upload. What do I do?", grounding: ["fix-upload-problems"] },
  {
    ask: "Do I have to connect my accounting software?",
    grounding: ["connect CapVeri to my accounting software", "You upload your files"],
  },
  { ask: "What files do I need to start?", grounding: ["What files do I need before I start?"] },
  { ask: "Is my data safe?", grounding: ["Is my data safe?", "We encrypt your files"] },
  { ask: "How do I send results to a tenant?", grounding: ["How do I send results to a tenant?"] },
  { ask: "Where do I see my buildings?", grounding: ["Properties", "/properties"] },
  { ask: "Where are my uploaded files?", grounding: ["Documents", "/documents"] },
  { ask: "Where do the results live?", grounding: ["Reports", "/reports"] },
  { ask: "Where do I invite people?", grounding: ["Team settings", "/settings/team"] },
  { ask: "Where do I start?", grounding: ["Dashboard", "/dashboard"] },
  { ask: "Where does the math happen?", grounding: ["Reconciliations", "/reconciliations"] },
];

const CONTEXT_MARKER = "Signed app context:";

function assembledSystemPrompt(): string {
  const payload = buildOpenRouterPayload({}, teacherContext, "hello", [], "/dashboard");
  const messages = payload.messages as Array<{ role: string; content: string }>;
  return messages.find((m) => m.role === "system")?.content ?? "";
}

/**
 * The slice of the system prompt that holds the embedded signed context. A
 * grounding token found HERE is real data the model can teach from; a token
 * found only in the instruction boilerplate above the marker proves nothing.
 */
function contextRegion(prompt: string): string {
  const at = prompt.indexOf(CONTEXT_MARKER);
  return at === -1 ? "" : prompt.slice(at);
}

describe("AI-CS teacher brain — beginner-question coverage eval", () => {
  const prompt = assembledSystemPrompt();
  const context = contextRegion(prompt);

  it("embeds the signed context after the marker", () => {
    expect(prompt).toContain(CONTEXT_MARKER);
    expect(context.length).toBeGreaterThan(CONTEXT_MARKER.length);
  });

  it("has at least 25 beginner questions in the eval set", () => {
    expect(BEGINNER_QUESTIONS.length).toBeGreaterThanOrEqual(25);
  });

  it("lands grounded material in the context region for 100% of beginner questions", () => {
    const gaps: string[] = [];
    for (const q of BEGINNER_QUESTIONS) {
      const missing = q.grounding.filter((token) => !context.includes(token));
      if (missing.length > 0) {
        gaps.push(`"${q.ask}" is missing grounding: ${missing.join(", ")}`);
      }
    }
    // For THIS representative context, every beginner question has its answer
    // in the embedded data. A gap means assembly dropped material that the
    // fixture carries — the real-knowledge coverage gate runs on the product side.
    expect(gaps).toEqual([]);
  });

  it.each(BEGINNER_QUESTIONS)("covers: $ask", ({ grounding }) => {
    for (const token of grounding) {
      expect(context).toContain(token);
    }
  });

  it("finds NO grounding for an off-product question, forcing abstention", () => {
    // None of these belong to CapVeri's context. The model is told the context
    // is its only source of truth and to say it does not know when the answer
    // is absent — so the inverse property must hold: these tokens are nowhere
    // in the embedded data.
    const offProductTokens = [
      "QuickBooks",
      "mobile app",
      "reset my password",
      "cancel my subscription",
      "phone number",
    ];
    for (const token of offProductTokens) {
      expect(context).not.toContain(token);
    }
  });
});

describe("AI-CS teacher brain — prompt quality invariants", () => {
  const prompt = assembledSystemPrompt();

  it("teaches a beginner in plain, short, no-hype language", () => {
    expect(prompt).toContain("beginner");
    expect(prompt).toContain("short sentences");
    expect(prompt).toContain("plain words");
    expect(prompt).toContain("Give the answer first");
    expect(prompt).toContain("no emoji");
  });

  it("instructs the model to USE concepts, howtos, and faqs", () => {
    expect(prompt).toContain("concepts, howtos, and faqs");
    expect(prompt).toContain("define it in plain words");
    expect(prompt).toContain("numbered steps");
    expect(prompt).toContain("prerequisites");
  });

  it("enforces the no-lies rule and grounding in exact UI names", () => {
    expect(prompt).toContain("only source of truth");
    expect(prompt).toContain("Never invent");
    expect(prompt).toContain("Do not guess");
    expect(prompt).toContain("exact menu, screen, button, and path");
  });

  it("does not push human support", () => {
    expect(prompt).toContain("Do not offer or push human help");
  });
});
