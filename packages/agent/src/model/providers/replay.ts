import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ModelError,
  ModelProvider,
  ProviderCapabilities,
  ProviderRequest,
  ProviderResponse,
} from "../types.js";

/**
 * A recorded exchange. `key` is a hash of everything that determines the
 * response, so a replay is only served when the request is genuinely identical.
 */
interface Cassette {
  provider: string;
  model: string;
  entries: Record<string, ProviderResponse>;
}

/**
 * Hash of the request fields that affect the answer. Deliberately excludes the
 * abort signal and anything non-deterministic.
 */
export function requestKey(model: string, request: ProviderRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        model,
        system: request.system,
        messages: request.messages,
        tools: request.tools.map((tool) => tool.name).sort(),
        responseSchema: request.responseSchema ?? null,
        temperature: request.temperature,
      }),
    )
    .digest("hex");
}

async function loadCassette(file: string): Promise<Cassette | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Cassette;
  } catch {
    return undefined;
  }
}

/**
 * Wraps a real provider and writes every exchange to a cassette file.
 *
 * Recording once turns an expensive, non-deterministic pipeline into a fixture
 * that {@link ReplayProvider} can re-run offline, in CI, with no API key.
 */
export class RecordingProvider implements ModelProvider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;

  private readonly inner: ModelProvider;
  private readonly file: string;
  private entries: Record<string, ProviderResponse> = {};
  private loaded = false;

  constructor(inner: ModelProvider, file: string) {
    this.inner = inner;
    this.file = file;
    this.id = `recording:${inner.id}`;
    this.model = inner.model;
    this.capabilities = inner.capabilities;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    if (!this.loaded) {
      this.entries = (await loadCassette(this.file))?.entries ?? {};
      this.loaded = true;
    }
    const response = await this.inner.complete(request);
    this.entries[requestKey(this.inner.model, request)] = response;
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(
      this.file,
      JSON.stringify(
        { provider: this.inner.id, model: this.inner.model, entries: this.entries } satisfies Cassette,
        null,
        2,
      ),
      "utf8",
    );
    return response;
  }
}

/**
 * Serves recorded responses. A request with no recording is an error rather
 * than a silent live call, so a replayed test can never quietly start spending
 * money or depending on the network.
 */
export class ReplayProvider implements ModelProvider {
  readonly id = "replay";
  readonly model: string;
  readonly capabilities: ProviderCapabilities;

  private readonly file: string;
  private cassette?: Cassette;

  constructor(file: string, options: { model?: string; capabilities?: ProviderCapabilities } = {}) {
    this.file = file;
    this.model = options.model ?? "replay";
    this.capabilities = options.capabilities ?? {
      jsonSchema: true,
      parallelToolCalls: true,
      systemPrompt: true,
      maxContextTokens: 1_000_000,
    };
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    if (!this.cassette) {
      const cassette = await loadCassette(this.file);
      if (!cassette) throw new ModelError("invalid_request", `No cassette at ${this.file}`);
      this.cassette = cassette;
    }
    const key = requestKey(this.cassette.model, request);
    const recorded = this.cassette.entries[key];
    if (!recorded) {
      throw new ModelError(
        "invalid_request",
        `No recorded response for this request (key ${key.slice(0, 12)}). ` +
          `Re-record the cassette at ${this.file} if the prompt or tools changed.`,
      );
    }
    return recorded;
  }
}
