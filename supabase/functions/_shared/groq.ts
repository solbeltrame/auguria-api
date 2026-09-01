import { encodeBase64 } from "jsr:@std/encoding/base64";

const GROQ_API_URL = "https://api.groq.com/openai/v1";
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_INLINE_IMAGE_BYTES = 4 * 1000 * 1000;

export type GroqUsage = Record<string, unknown>;

export type GroqMessage = {
  role: "system" | "user" | "assistant";
  content:
    | string
    | Array<{
      type: "text" | "image_url";
      text?: string;
      image_url?: { url: string };
    }>;
};

type GroqResponse = {
  choices?: Array<{
    message?: { content?: string | Array<{ type?: string; text?: string }> };
  }>;
  usage?: GroqUsage;
};

function responseText(response: GroqResponse): string {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim();
}

async function requestGroq(
  path: string,
  init: RequestInit,
  apiKey: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${GROQ_API_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(init.headers || {}),
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Groq API respondeu HTTP ${response.status}`);
    }
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Groq API excedeu o tempo limite de processamento");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function groqChat(
  messages: GroqMessage[],
  apiKey: string,
  options: {
    model: string;
    temperature?: number;
    maxCompletionTokens?: number;
    json?: boolean;
  },
): Promise<{ text: string; usage?: GroqUsage }> {
  if (!apiKey.trim()) throw new Error("Chave da API Groq não configurada");
  const body: Record<string, unknown> = {
    model: options.model,
    messages,
    temperature: options.temperature ?? 0.1,
    max_completion_tokens: options.maxCompletionTokens ?? 4_000,
  };
  if (options.json) body.response_format = { type: "json_object" };

  const response = await requestGroq(
    "/chat/completions",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    apiKey,
  );
  const parsed = await response.json() as GroqResponse;
  const text = responseText(parsed);
  if (!text) throw new Error("Groq não retornou conteúdo");
  return { text, usage: parsed.usage };
}

export async function groqVision(
  bytes: Uint8Array,
  mimeType: string,
  prompt: string,
  apiKey: string,
  model: string,
  options: { json?: boolean; maxCompletionTokens?: number } = {},
): Promise<{ text: string; usage?: GroqUsage }> {
  if (bytes.byteLength > MAX_INLINE_IMAGE_BYTES) {
    throw new Error(
      "A imagem excede o limite de 4 MB para envio direto ao Groq; use uma URL assinada ou reduza o arquivo",
    );
  }
  return await groqChat(
    [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        {
          type: "image_url",
          image_url: {
            url: `data:${mimeType};base64,${encodeBase64(bytes)}`,
          },
        },
      ],
    }],
    apiKey,
    {
      model,
      temperature: 0.1,
      maxCompletionTokens: options.maxCompletionTokens ?? 8_000,
      json: options.json,
    },
  );
}

export async function groqVisionUrl(
  imageUrl: string,
  prompt: string,
  apiKey: string,
  model: string,
  options: { json?: boolean; maxCompletionTokens?: number } = {},
): Promise<{ text: string; usage?: GroqUsage }> {
  return await groqChat(
    [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: imageUrl } },
      ],
    }],
    apiKey,
    {
      model,
      temperature: 0.1,
      maxCompletionTokens: options.maxCompletionTokens ?? 8_000,
      json: options.json,
    },
  );
}

export async function groqVisionBatch(
  images: Array<{ bytes: Uint8Array; mimeType: string }>,
  prompt: string,
  apiKey: string,
  model: string,
  options: { maxCompletionTokens?: number } = {},
): Promise<{ text: string; usage?: GroqUsage }> {
  const content: GroqMessage["content"] = [{ type: "text", text: prompt }];
  for (const image of images) {
    if (image.bytes.byteLength > MAX_INLINE_IMAGE_BYTES) {
      throw new Error(
        "Uma das páginas renderizadas excede o limite de 4 MB para imagens em base64 no Groq",
      );
    }
    content.push({
      type: "image_url",
      image_url: {
        url: `data:${image.mimeType};base64,${encodeBase64(image.bytes)}`,
      },
    });
  }
  return await groqChat(
    [{ role: "user", content }],
    apiKey,
    {
      model,
      temperature: 0.1,
      maxCompletionTokens: options.maxCompletionTokens ?? 8_000,
    },
  );
}

export async function groqTranscribe(
  bytes: Uint8Array,
  mimeType: string,
  fileName: string,
  apiKey: string,
  model: string,
  options: { language?: string; prompt?: string } = {},
): Promise<{ text: string; usage?: GroqUsage }> {
  if (bytes.byteLength > 25 * 1000 * 1000) {
    throw new Error("O áudio excede o limite de 25 MB aceito pelo Groq");
  }
  const form = new FormData();
  form.append(
    "file",
    new File([bytes as unknown as BlobPart], fileName || "audio", {
      type: mimeType,
    }),
  );
  form.append("model", model);
  form.append("response_format", "json");
  if (options.language) form.append("language", options.language);
  if (options.prompt) form.append("prompt", options.prompt);

  const response = await requestGroq(
    "/audio/transcriptions",
    { method: "POST", body: form },
    apiKey,
  );
  const parsed = await response.json() as {
    text?: string;
    usage?: GroqUsage;
  };
  const text = parsed.text?.trim() ?? "";
  if (!text) throw new Error("Groq não encontrou fala no áudio");
  return { text, usage: parsed.usage };
}
