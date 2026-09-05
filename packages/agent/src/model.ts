export type ModelTool = { name: string; description: string; parameters: Record<string, unknown> };
export type ModelRequest = {
  system: string;
  input: unknown;
  tools: ModelTool[];
  execute?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  maxTurns?: number;
};
export type ModelResult = { text: string; modelCalls: number; toolCalls: number; contextChars: number };
export interface AgentModel {
  generate(request: ModelRequest): Promise<ModelResult>;
}
const withUsage = (error: unknown, modelCalls: number, toolCalls: number) =>
  Object.assign(error instanceof Error ? error : new Error(String(error)), { modelCalls, toolCalls });

type Part = {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: unknown };
};
type Content = { role: "user" | "model"; parts: Part[] };
export class GeminiModel implements AgentModel {
  async generate(request: ModelRequest): Promise<ModelResult> {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY is missing");
    const model = process.env.GEMINI_MODEL ?? "gemini-3.8-flash",
      input = JSON.stringify(request.input),
      history: Content[] = [{ role: "user", parts: [{ text: input }] }],
      maxTurns = request.maxTurns ?? 12;
    let calls = 0,
      toolCalls = 0,
      final = "";
    for (let turn = 0; turn < maxTurns; turn++) {
      const body = JSON.stringify({
        systemInstruction: { parts: [{ text: request.system }] },
        contents: history,
        ...(request.tools.length ? { tools: [{ functionDeclarations: request.tools }] } : {}),
        generationConfig: { temperature: 0.1, maxOutputTokens: 8192 },
      });
      let response: Response | undefined;
      for (let attempt = 0; attempt < 4; attempt++) {
        calls++;
        try {
          response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
            {
              method: "POST",
              headers: { "content-type": "application/json", "x-goog-api-key": key },
              signal: AbortSignal.timeout(120_000),
              body,
            },
          );
        } catch (error) {
          throw withUsage(error, calls, toolCalls);
        }
        if (response.ok || ![429, 500, 502, 503, 504].includes(response.status) || attempt === 3) break;
        const detail = await response.text(),
          headerSeconds = Number(response.headers.get("retry-after")),
          messageSeconds = Number(detail.match(/retry(?:Delay)?(?:\"\s*:\s*\"| in )([\d.]+)s/i)?.[1]),
          suggestedMs =
            Number.isFinite(headerSeconds) && headerSeconds > 0
              ? headerSeconds * 1000
              : Number.isFinite(messageSeconds) && messageSeconds > 0
                ? messageSeconds * 1000
                : 0,
          delayMs = Math.min(60_000, Math.max(500 * 2 ** attempt, suggestedMs + 250));
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      if (!response)
        throw withUsage(new Error("Gemini request did not produce a response"), calls, toolCalls);
      if (!response.ok)
        throw withUsage(
          new Error(`Gemini ${response.status}: ${(await response.text()).slice(0, 1000)}`),
          calls,
          toolCalls,
        );
      const data = (await response.json()) as { candidates?: Array<{ content: Content }> },
        content = data.candidates?.[0]?.content;
      if (!content) throw withUsage(new Error("Gemini returned no candidate"), calls, toolCalls);
      history.push(content);
      const functionCalls = content.parts.flatMap((p) => (p.functionCall ? [p.functionCall] : [])),
        text = content.parts.map((p) => p.text ?? "").join("\n");
      if (text) final = text;
      if (!functionCalls.length)
        return { text: final, modelCalls: calls, toolCalls, contextChars: input.length };
      if (!request.execute)
        throw withUsage(new Error("This agent is not permitted to call tools"), calls, toolCalls);
      const results: Part[] = [];
      for (const call of functionCalls) {
        toolCalls++;
        try {
          results.push({
            functionResponse: {
              name: call.name,
              response: { result: await request.execute(call.name, call.args) },
            },
          });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          results.push({ functionResponse: { name: call.name, response: { error: detail } } });
        }
      }
      if (turn === maxTurns - 2)
        results.push({
          text: "Tool budget exhausted. Do not call another tool. Return the required final JSON now using the evidence already collected.",
        });
      history.push({ role: "user", parts: results });
    }
    throw withUsage(new Error("Agent exceeded its maximum model iterations"), calls, toolCalls);
  }
}

export function parseStructured<T>(text: string): T {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = cleaned.indexOf("{"),
    end = cleaned.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Agent did not return structured JSON");
  return JSON.parse(cleaned.slice(start, end + 1)) as T;
}
