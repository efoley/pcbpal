/**
 * Model transport for the eval harness.
 *
 * `AnthropicTransport` calls the Anthropic Messages API directly via `fetch`
 * (no SDK dependency), so the harness stays a thin, auditable client.
 * `MockTransport` replays a scripted queue of responses and is what the tests
 * and `--dry-run` use — the harness is therefore fully exercisable offline,
 * with no network and no API key.
 */

// ── Request / response shape ──

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image_base64_png"; data: string };

export interface ModelMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export interface ModelRequest {
  system?: string;
  messages: ModelMessage[];
  model: string;
  maxTokens: number;
  forceJson?: boolean;
}

export interface ModelResponse {
  text: string;
  usage: { input_tokens: number; output_tokens: number };
}

export interface ModelTransport {
  complete(req: ModelRequest): Promise<ModelResponse>;
}

// ── Anthropic Messages API (live) ──

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

interface AnthropicContentPart {
  type: "text" | "image";
  text?: string;
  source?: { type: "base64"; media_type: "image/png"; data: string };
}

function toAnthropicContent(blocks: ContentBlock[]): AnthropicContentPart[] {
  return blocks.map((b) => {
    if (b.type === "text") return { type: "text", text: b.text };
    return {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: b.data },
    };
  });
}

export class AnthropicTransport implements ModelTransport {
  private readonly apiKey: string;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set — export it, or run with --dry-run for an offline plumbing check.",
      );
    }
    this.apiKey = key;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    // The API has no hard "JSON mode"; nudge via system when asked.
    const system =
      req.forceJson === true
        ? `${req.system ? `${req.system}\n\n` : ""}Respond with a single JSON object and nothing else — no prose, no markdown fences.`
        : req.system;

    const body = {
      model: req.model,
      max_tokens: req.maxTokens,
      ...(system ? { system } : {}),
      messages: req.messages.map((m) => ({
        role: m.role,
        content: toAnthropicContent(m.content),
      })),
    };

    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Anthropic API error ${res.status}: ${detail.slice(0, 500)}`);
    }

    const data = (await res.json()) as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (data.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("");

    return {
      text,
      usage: {
        input_tokens: data.usage?.input_tokens ?? 0,
        output_tokens: data.usage?.output_tokens ?? 0,
      },
    };
  }
}

// ── Mock transport (tests + --dry-run) ──

/**
 * Replays a fixed queue of response strings. Each `complete()` shifts the next
 * response. If the queue empties it throws (a test that under-scripts responses
 * should fail loudly rather than silently repeat).
 */
export class MockTransport implements ModelTransport {
  private readonly queue: string[];
  public readonly requests: ModelRequest[] = [];

  constructor(responses: string[]) {
    this.queue = [...responses];
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(req);
    const next = this.queue.shift();
    if (next === undefined) {
      throw new Error("MockTransport queue exhausted: more model calls than scripted responses");
    }
    return {
      text: next,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }
}
