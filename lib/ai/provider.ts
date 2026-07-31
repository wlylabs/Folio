/**
 * The model call behind article mode: Groq first, Gemini if Groq can't answer.
 *
 * Both are spoken to over plain HTTP rather than through an SDK. The two
 * request shapes are about thirty lines each, they are stable, and adding two
 * vendor SDKs to a wallet app to send two POST requests would be the larger
 * cost — a bigger client bundle risk, two more supply-chain surfaces, and two
 * more things to keep on version.
 *
 * ## Why a fallback at all
 *
 * Groq is the primary because it is fast enough that a writer waiting on a
 * draft doesn't leave. It is also aggressively rate limited on a free key, and
 * a 429 in the middle of a generation is the failure a person actually hits.
 * Gemini answers slower and rarely refuses, which makes it the right second
 * chair: the draft still arrives, and `provider` on the result says which one
 * wrote it so the byline can be honest about it.
 *
 * Every failure falls through, not just the rate limits. That is deliberate:
 * each of the ways Groq can refuse — a revoked key, a model name that has been
 * retired, a prompt over the context window, an outage — is a condition the
 * other provider does not share, so there is no failure here worth stopping on.
 * What the caller gets back instead is `attempts`, the trail of who refused and
 * why, so a deployment silently running on its fallback is visible rather than
 * merely slow.
 *
 * ## This module is server-only
 *
 * Both keys are read from unprefixed environment variables, so they never reach
 * a NEXT_PUBLIC_ bundle. Nothing here may be imported from a client component.
 */

/** Reasonable free-tier defaults; override per deployment. */
const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";
const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";

/**
 * A generation runs long — a thousand words is not a chat reply — but not
 * forever. Past this the fallback is a better bet than the wait, and a route
 * handler that never returns is worse than one that says it failed.
 */
const TIMEOUT_MS = 60_000;

export type ProviderName = "groq" | "gemini";

export type CompletionRequest = {
  /** The instruction block. Sent as a system message / system instruction. */
  system: string;
  /** The task itself. */
  prompt: string;
  /**
   * Low for this work on purpose. The agent is rewriting reported facts, and
   * temperature is exactly the dial that invents the ones it wasn't given.
   */
  temperature?: number;
  maxTokens?: number;
};

export type CompletionResult = {
  text: string;
  provider: ProviderName;
  model: string;
  /** Providers tried and why each failed, oldest first. Empty on a clean run. */
  attempts: FailedAttempt[];
};

export type FailedAttempt = { provider: ProviderName; reason: string };

/** Thrown when every configured provider failed. Carries the whole trail. */
export class NoProviderError extends Error {
  readonly attempts: FailedAttempt[];

  constructor(attempts: FailedAttempt[]) {
    const detail = attempts.length
      ? attempts.map((a) => `${a.provider}: ${a.reason}`).join("; ")
      : "no provider is configured — set GROQ_API_KEY or GEMINI_API_KEY";
    super(`The article agent could not reach a model (${detail}).`);
    this.name = "NoProviderError";
    this.attempts = attempts;
  }
}

/** True when at least one provider has a key, so callers can say so up front. */
export function isAgentConfigured(): boolean {
  return Boolean(process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY);
}

/** Which providers are usable, in the order they will be tried. */
export function configuredProviders(): ProviderName[] {
  const order: ProviderName[] = [];
  if (process.env.GROQ_API_KEY) order.push("groq");
  if (process.env.GEMINI_API_KEY) order.push("gemini");
  return order;
}

/**
 * Ask the first provider that answers.
 *
 * Resolves with the text and the provider that produced it. Rejects with
 * {NoProviderError} only when all of them failed — a caller never has to know
 * which one ran.
 */
export async function complete(request: CompletionRequest): Promise<CompletionResult> {
  const attempts: FailedAttempt[] = [];

  for (const provider of configuredProviders()) {
    try {
      const { text, model } = await callProvider(provider, request);
      if (!text.trim()) throw new Error("returned an empty completion");
      return { text, provider, model, attempts };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      attempts.push({ provider, reason });
      // Log server-side: a fallback that fires silently every request is a
      // quota problem nobody finds until the bill or the rate limit does.
      console.warn(`[article-agent] ${provider} failed, trying the next provider:`, reason);
    }
  }

  throw new NoProviderError(attempts);
}

function callProvider(
  provider: ProviderName,
  request: CompletionRequest
): Promise<{ text: string; model: string }> {
  return provider === "groq" ? callGroq(request) : callGemini(request);
}

/* ==========================================================================
   Groq — OpenAI-compatible chat completions
   ========================================================================== */

async function callGroq(request: CompletionRequest): Promise<{ text: string; model: string }> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY is not set");
  const model = process.env.GROQ_MODEL || DEFAULT_GROQ_MODEL;

  const response = await postJson("https://api.groq.com/openai/v1/chat/completions", {
    headers: { authorization: `Bearer ${key}` },
    body: {
      model,
      // Groq honours this the way OpenAI does: the response is guaranteed to
      // parse as JSON, which is the contract lib/ai/writer.ts depends on.
      response_format: { type: "json_object" },
      temperature: request.temperature ?? 0.4,
      max_tokens: request.maxTokens ?? 4096,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.prompt },
      ],
    },
  });

  const text = response?.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("no message content in the Groq response");
  return { text, model };
}

/* ==========================================================================
   Gemini — generateContent
   ========================================================================== */

async function callGemini(request: CompletionRequest): Promise<{ text: string; model: string }> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;

  // The key goes in a header, not the query string: a URL with a secret in it
  // ends up in proxy logs and stack traces.
  const response = await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent`,
    {
      headers: { "x-goog-api-key": key },
      body: {
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: "user", parts: [{ text: request.prompt }] }],
        generationConfig: {
          temperature: request.temperature ?? 0.4,
          maxOutputTokens: request.maxTokens ?? 4096,
          responseMimeType: "application/json",
        },
      },
    }
  );

  const candidate = response?.candidates?.[0];
  // A candidate can come back with no parts at all when a safety filter or the
  // token ceiling stopped it. Saying which is the difference between a prompt
  // to fix and a limit to raise.
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    const finish = candidate?.finishReason || response?.promptFeedback?.blockReason || "unknown";
    throw new Error(`Gemini returned no content (finishReason: ${finish})`);
  }

  const text = parts
    .map((part: { text?: unknown }) => (typeof part.text === "string" ? part.text : ""))
    .join("");
  if (!text) throw new Error("no text in the Gemini response parts");
  return { text, model };
}

/* ==========================================================================
   Transport
   ========================================================================== */

/**
 * One POST, one timeout, one error vocabulary.
 *
 * Error bodies are truncated before they go into the message. Provider errors
 * can carry a kilobyte of echoed request, and that message ends up in a log and
 * sometimes in a response — long enough to bury the one line that matters.
 */
async function postJson(
  url: string,
  options: { headers: Record<string, string>; body: unknown }
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...options.headers },
      body: JSON.stringify(options.body),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`timed out after ${Math.round(TIMEOUT_MS / 1000)}s`);
    }
    throw new Error(`network error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`HTTP ${response.status}${detail ? ` — ${detail}` : ""}`);
  }

  try {
    return await response.json();
  } catch {
    throw new Error("the response body was not JSON");
  }
}
