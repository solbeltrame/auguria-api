import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  createUnsecureClient,
  type MessageRow,
  type Part,
  type WebhookPayload,
} from "../_shared/supabase.ts";
import {
  type ApiError,
  type GenerateContentResponse,
  GoogleGenAI,
} from "@google/genai";
import {
  createSignedUrl,
  downloadFromStorage,
  uploadToStorage,
} from "../_shared/media.ts";
import { encodeBase64 } from "jsr:@std/encoding/base64";
import * as log from "../_shared/logger.ts";
import { stringify } from "jsr:@std/csv/stringify";
import { Json } from "../_shared/db_types.ts";
import {
  groqChat,
  groqTranscribe,
  groqVision,
  groqVisionBatch,
  groqVisionUrl,
} from "../_shared/groq.ts";
import { renderPdfPages } from "../_shared/pdf-renderer.ts";

type ModalityTokenCount = { modality: string; tokenCount: number };

type MediaPreprocessingResult = {
  transcription?: string;
  description?: string;
  table?: Array<Array<string>>;
};

type MediaPreprocessingConfig = {
  mode?: "active" | "inactive";
  provider?: "google" | "groq";
  model?: string;
  transcription_model?: string;
  api_key?: string;
  language?: string;
  extra_prompt?: string;
};

function calculateCost(
  usage: GenerateContentResponse["usageMetadata"],
  pricing: Record<string, number>,
  quantity: number,
): number {
  if (!usage) return 0;

  const cached = usage.cachedContentTokenCount ?? 0;
  const completion = usage.candidatesTokenCount ?? 0;

  let inputCost = 0;
  const promptDetails = usage.promptTokensDetails as
    | ModalityTokenCount[]
    | undefined;
  const cacheDetails = usage.cacheTokensDetails as
    | ModalityTokenCount[]
    | undefined;

  if (promptDetails?.length) {
    for (const { modality, tokenCount } of promptDetails) {
      const key = modality === "TEXT"
        ? "input"
        : `${modality.toLowerCase()}_input`;
      inputCost += tokenCount * (pricing[key] ?? pricing.input ?? 0);
    }
    // Subtract cached tokens at full rate, add back at per-modality cache rate
    if (cacheDetails?.length) {
      for (const { modality, tokenCount } of cacheDetails) {
        const inputKey = modality === "TEXT"
          ? "input"
          : `${modality.toLowerCase()}_input`;
        const cacheKey = modality === "TEXT"
          ? "cache_read"
          : `${modality.toLowerCase()}_cache_read`;
        inputCost -= tokenCount * (pricing[inputKey] ?? pricing.input ?? 0);
        inputCost += tokenCount *
          (pricing[cacheKey] ?? pricing.cache_read ?? pricing.input ?? 0);
      }
    } else if (cached > 0) {
      inputCost -= cached * (pricing.input ?? 0);
      inputCost += cached * (pricing.cache_read ?? pricing.input ?? 0);
    }
  } else {
    // Fallback: no modality breakdown
    const prompt = usage.promptTokenCount ?? 0;
    inputCost = (prompt - cached) * (pricing.input ?? 0) +
      cached * (pricing.cache_read ?? pricing.input ?? 0);
  }

  return (inputCost + completion * (pricing.output ?? 0)) / quantity;
}

function speechLanguage(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (/^[a-z]{2}(?:-[a-z]{2})?$/.test(normalized)) {
    return normalized.slice(0, 2);
  }
  if (normalized.includes("portugu")) return "pt";
  if (normalized.includes("spanish") || normalized.includes("español")) {
    return "es";
  }
  if (normalized.includes("english") || normalized.includes("inglês")) {
    return "en";
  }
  return undefined;
}

function parseModelJson(value: string): MediaPreprocessingResult | undefined {
  const cleaned = value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  try {
    const parsed = JSON.parse(cleaned) as MediaPreprocessingResult;
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function preprocessWithGroq(
  bytes: Uint8Array,
  mimeType: string,
  mediaType: string,
  fileName: string,
  prompt: string,
  config: MediaPreprocessingConfig,
  apiKey: string,
  model: string,
  transcriptionModel: string,
  imageUrl?: string,
): Promise<
  { result: MediaPreprocessingResult; usage?: Record<string, unknown> }
> {
  if (mediaType === "audio") {
    const response = await groqTranscribe(
      bytes,
      mimeType,
      fileName,
      apiKey,
      transcriptionModel,
      { language: speechLanguage(config.language) },
    );
    return {
      result: {
        transcription: response.text,
        description: "Áudio transcrito pelo Groq Whisper.",
      },
      usage: response.usage,
    };
  }

  if (mediaType === "image") {
    if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType)) {
      throw new Error(
        `O Groq aceita imagens PNG, JPEG ou WebP; ${mimeType} precisa ser convertido antes do envio`,
      );
    }
    const imagePrompt =
      `${prompt}\nResponda exclusivamente em JSON com as chaves transcription, description e table.`;
    const response = imageUrl
      ? await groqVisionUrl(imageUrl, imagePrompt, apiKey, model, {
        json: true,
      })
      : await groqVision(
        bytes,
        mimeType,
        imagePrompt,
        apiKey,
        model,
        { json: true },
      );
    return {
      result: parseModelJson(response.text) || { transcription: response.text },
      usage: response.usage,
    };
  }

  if (mimeType === "application/pdf") {
    const rendered = await renderPdfPages(bytes);
    const sections: string[] = [];
    const usages: Record<string, unknown>[] = [];
    for (let index = 0; index < rendered.images.length; index += 3) {
      const response = await groqVisionBatch(
        rendered.images.slice(index, index + 3).map((image) => ({
          bytes: image,
          mimeType: "image/png",
        })),
        `${prompt}\nLeia as páginas na ordem apresentada e preserve a separação por página. Responda em Markdown, sem inventar conteúdo.`,
        apiKey,
        model,
        { maxCompletionTokens: 10_000 },
      );
      sections.push(response.text);
      if (response.usage) usages.push(response.usage);
    }
    const suffix = rendered.pageCount > rendered.renderedPages
      ? `\n\n[As primeiras ${rendered.renderedPages} páginas foram processadas; o PDF possui ${rendered.pageCount} páginas.]`
      : "";
    return {
      result: {
        transcription: `${sections.join("\n\n")}${suffix}`,
        description: "PDF interpretado visualmente pelo Groq.",
      },
      usage: usages.length ? { requests: usages.length } : undefined,
    };
  }

  if (mediaType === "document" && mimeType.startsWith("text/")) {
    const text = new TextDecoder().decode(bytes).slice(0, 300_000);
    const response = await groqChat(
      [{ role: "user", content: `${prompt}\n\nCONTEÚDO DO ARQUIVO:\n${text}` }],
      apiKey,
      { model, temperature: 0.1, maxCompletionTokens: 4_000, json: true },
    );
    return {
      result: parseModelJson(response.text) || { description: response.text },
      usage: response.usage,
    };
  }

  if (mediaType === "video") {
    throw new Error(
      "O Groq não interpreta vídeos diretamente. Selecione Google/Gemini para vídeos ou envie uma imagem",
    );
  }

  throw new Error(`O Groq não suporta o formato ${mimeType}`);
}

/**
 * Documentation for automatic file annotation handling:
 *
 * The file parts have these fields available for the LLM:
 *
 * - `description`: about 500 characters (0.5KB)
 * - `transcription`: about 2000 characters (2KB)
 *
 * Transcription is the human readable text content of the document.
 *
 * - For CSV is the same as the file content.
 * - For HTML is the text content of the HTML tags.
 *
 * 1. Text-based documents
 *
 *    A. Large (> 1KB)
 *
 *       Only the "head" (first 1KB) of the content is included in the `transcription` for the LLM.
 *       The full file is always available for direct reading if needed.
 *
 *     B. Small (≤ 1KB)
 *
 *        The entire content is included in the `transcription` so the LLM has it at hand.
 *        The full file is also available for direct reading.
 *
 * 2. Enriched documents (PDF)
 *
 *    The same size criteria apply: if small, include the whole content; if large, only the head.
 *    If the document is large, an auxiliary file for the LLM is also generated.
 *
 * Notes:
 *
 * - WhatsApp Cloud API file size limits
 *     Audio: 16MB, Image: 5MB, Video: 16MB, Document: 100MB, Sticker: 100KB static/500KB animated
 * - Gemini limits
 *     PDFs up to 1000 pages
 * - Edge Functions limits
 *     Maximum Duration (Wall clock limit): Free plan: 150s, Paid plans: 400s
 */
const MAX_SMALL_DOCUMENT_SIZE = 2 * 1000; // 2 KB
const INLINE_DATA_SIZE_LIMIT = 19 * 1000 * 1000; // 19MB

const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");

  if (token !== SERVICE_ROLE_KEY) {
    return new Response("Unauthorized", { status: 401 });
  }

  const client = createUnsecureClient();

  const incoming = ((await req.json()) as WebhookPayload<MessageRow>).record!;

  const log_update_and_respond = async (
    logLevel: "error" | "warn" | "info",
    logMessage: string,
  ) => {
    log[logLevel](logMessage);

    await client
      .from("messages")
      .update({ status: { preprocessed: new Date().toISOString() } })
      .eq("id", incoming.id)
      .throwOnError();

    return new Response();
  };

  const { data: conv } = await client
    .from("conversations")
    .select(`*, organizations (*)`)
    .eq("id", incoming.conversation_id)
    .single()
    .throwOnError();

  const org = conv.organizations;

  if (!conv.extra) {
    conv.extra = {};
  }

  if (!org.extra) {
    org.extra = {};
  }

  const config =
    (org.extra.media_preprocessing || {}) as MediaPreprocessingConfig;

  if (config.mode !== "active") {
    return log_update_and_respond(
      "info",
      "Media preprocessing mode is not active. Skipping preprocessing.",
    );
  }

  const provider = config.provider ||
    (config.model?.startsWith("qwen/") ? "groq" : "google");
  const model = config.model ||
    (provider === "groq" ? "qwen/qwen3.6-27b" : "gemini-2.5-flash");
  const transcriptionModel = config.transcription_model ||
    "whisper-large-v3-turbo";

  const language = config.language || "English";

  const apiKey = config.api_key ||
    (provider === "groq"
      ? Deno.env.get("GROQ_API_KEY")
      : Deno.env.get("GOOGLE_API_KEY"));

  if (!apiKey) {
    return log_update_and_respond(
      "warn",
      `${provider.toUpperCase()} API key not set. Skipping preprocessing.`,
    );
  }

  const { content, status } = incoming;

  if (content.type !== "file") {
    return log_update_and_respond(
      "error",
      "Incoming message is not a file. Skipping preprocessing.",
    );
  }

  const mimeType = content.file.mime_type.split(";", 1)[0];
  const mediaType = content.kind === "sticker" ? "image" : content.kind;
  const processingMediaType = [
      "story",
      "ig_story",
      "story_mention",
      "story_reply",
    ].includes(mediaType)
    ? mimeType.startsWith("image/") ? "image" : "video"
    : mediaType;

  const imageMimeTypes = [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/heic",
    "image/heif",
  ];
  const videoMimeTypes = [
    "video/mp4",
    "video/mpeg",
    "video/mov",
    "video/avi",
    "video/x-flv",
    "video/mpg",
    "video/webm",
    "video/wmv",
    "video/3gpp",
  ];
  // Instagram "native" shares (post/reel/story/story_mention/story_reply) can be
  // either an image or a video, so they accept both.
  const igShareMimeTypes = [...imageMimeTypes, ...videoMimeTypes];

  const allowedMimeTypes: Record<string, string[]> = {
    audio: [
      "audio/wav",
      "audio/mp3",
      "audio/mpeg",
      "audio/mp4",
      "audio/webm",
      "audio/opus",
      "audio/amr",
      "audio/aiff",
      "audio/aac",
      "audio/ogg",
      "audio/flac",
    ],
    image: imageMimeTypes,
    sticker: imageMimeTypes,
    video: videoMimeTypes,
    document: [
      "application/pdf", // PDF is the only mime type which goes through visual recognition
      // All the other mime types extract text content
      // "text/*"
      "application/json",
      "application/xml",
      "application/javascript",
      "application/sql",
      "application/rtf",
    ],
    story: igShareMimeTypes,
    ig_story: igShareMimeTypes,
    story_mention: igShareMimeTypes,
    story_reply: igShareMimeTypes,
  };

  const isSupportedMimeType = mimeType.startsWith("text/") ||
    allowedMimeTypes[mediaType]?.includes(mimeType.split(";")[0]); // "audio/ogg; codecs=opus" -> "audio/ogg"

  if (!isSupportedMimeType) {
    return log_update_and_respond(
      "warn",
      `Unsupported mime type ${mimeType} for media type ${mediaType}. Skipping preprocessing.`,
    );
  }

  // Check if we need to use File API vs inline data. Max payload size is 20MB.
  // Use 19MB limit to leave space for prompt and other request data.
  // We multiply by 1.33 to account for the base64 encoding overhead.
  // An unknown size (external URL) attempts the inline path.
  const shouldUseFileAPI = (content.file.size ?? 0) * 1.33 >
    INLINE_DATA_SIZE_LIMIT;

  if (provider === "google" && shouldUseFileAPI) {
    return log_update_and_respond(
      "warn",
      "Base64 encoded data size exceeds 19MB limit. File should be uploaded using the Gemini File API but it is not implemented yet.",
    );
  }

  const billable = provider === "google" && !config.api_key;
  let costs: { pricing: Record<string, number>; quantity: number } | null =
    null;

  if (provider === "google") {
    const { data } = await client
      .schema("billing")
      .from("costs")
      .select("pricing, quantity")
      .eq("provider", "google")
      .eq("product", model)
      .lte("effective_at", new Date().toISOString())
      .order("effective_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .throwOnError();
    costs = data as {
      pricing: Record<string, number>;
      quantity: number;
    } | null;
  }

  if (billable) {
    if (!costs) {
      return log_update_and_respond(
        "warn",
        `No pricing found for google/${model}`,
      );
    }

    const { error } = await client
      .schema("billing")
      .rpc("check_limit", {
        _organization_id: org.id,
        _product_id: "ai_credits",
        _amount: 0,
      });

    if (error) {
      return log_update_and_respond(
        "warn",
        `AI credits check failed: ${error.message}`,
      );
    }
  }

  await client
    .from("messages")
    .update({ status: { preprocessing: new Date().toISOString() } })
    .eq("id", incoming.id)
    .throwOnError();

  const file = await downloadFromStorage(client, content.file.uri);
  const bytes = new Uint8Array(await file.arrayBuffer());

  let imageUrl: string | undefined;
  if (provider === "groq" && processingMediaType === "image") {
    try {
      imageUrl = await createSignedUrl(client, content.file.uri);
    } catch (error) {
      log.warn("Could not create a signed media URL for Groq", error);
    }
  }

  let prompt = "";

  switch (mediaType) {
    case "audio":
      prompt =
        `Analyze this audio file. Provide a transcription of the audio content in its original language and a brief description in ${language} of what it contains (voice, music, noises, etc.). If it's voice, include emotion recognition in the description.`;
      break;
    case "video":
      prompt =
        `Analyze this video file. Provide a transcription of any audio content in its original language and a brief description in ${language} of what the video shows.`;
      break;
    case "image":
      prompt =
        `Analyze this image. If it contains text, extract it as transcription in its original language using markdown format if possible. Provide a brief description in ${language} of the image content, or if it's a document, specify the document type (invoice, receipt, etc.) and include relevant information (dates, amounts, etc.).`;
      break;
    case "document":
      if (mimeType === "text/csv") {
        prompt =
          `Analyze this CSV document. Do not transcribe! Do not extract the data as a table either! Provide a brief description in ${language} of the data (column names, row samples, etc.).`;
      } else if (mimeType === "application/pdf") {
        prompt =
          `Analyze this PDF document. Extract the text content as transcription in its original language using markdown format if possible. If the content includes a table, do not transcribe the table. Instead, provide the table as an array of arrays; the first row should contain the column names (if the header is multi-row, flatten it and pick sensible column names). Do not treat key-value data as a table (avoid single-row tables). Provide a brief description in ${language} of the document, specify the document type (invoice, receipt, etc.) and include relevant information (dates, amounts, etc.).`;
      } else {
        prompt =
          `Analyze this text document. Do not transcribe! If the content includes a table, provide the table as an array of arrays; the first row should contain the column names (if the header is multi-row, flatten it and pick sensible column names). Do not treat key-value data as a table (avoid single-row tables). Provide a brief description in ${language} of the document, specify the document type (invoice, receipt, etc.) and include relevant information (dates, amounts, etc.).`;
      }
      break;
    default:
      prompt =
        `Analyze this file and provide a transcription of any text content in its original language and a brief description in ${language} of what it contains.`;
  }

  if (config?.extra_prompt) {
    prompt += `\n\n${config.extra_prompt}`;
  }

  let result: MediaPreprocessingResult;
  let googleUsage: GenerateContentResponse["usageMetadata"] | undefined;

  if (provider === "groq") {
    try {
      const processed = await preprocessWithGroq(
        bytes,
        mimeType,
        processingMediaType,
        content.file.name || "arquivo",
        prompt,
        config,
        apiKey,
        model,
        transcriptionModel,
        imageUrl,
      );
      result = processed.result;
    } catch (error) {
      return log_update_and_respond(
        "error",
        `Groq API error in preprocessing. Skipping preprocessing. ${error}`,
      );
    }
  } else {
    const genai = new GoogleGenAI({ apiKey });
    const base64File = encodeBase64(bytes);
    const responseSchema = {
      type: "object",
      properties: {
        transcription: { type: "string" },
        description: { type: "string" },
        table: {
          type: "array",
          items: { type: "array", items: { type: "string" } },
        },
      },
    };
    const contents: Array<
      | { text: string }
      | { inlineData: { mimeType: string; data: string } }
    > = [{ inlineData: { mimeType, data: base64File } }];

    if (mediaType === "image") {
      contents.push({ text: prompt });
    } else {
      contents.unshift({ text: prompt });
    }

    let response: GenerateContentResponse;
    try {
      response = await genai.models.generateContent({
        model,
        contents,
        config: {
          responseMimeType: "application/json",
          responseSchema,
        },
      });
    } catch (error) {
      const status = (error as ApiError).status;
      if (status === 429) {
        const message = String(error);
        const isQuotaExhausted = message.includes("quota") ||
          message.includes("RESOURCE_EXHAUSTED");

        if (isQuotaExhausted) {
          return log_update_and_respond(
            "warn",
            `Gemini API quota exhausted for ${model}. Skipping preprocessing.`,
          );
        }
      }

      if ([429, 500, 503].includes(status)) {
        log.error("Retryable Gemini API error in preprocessing", error);
        throw error;
      }

      return log_update_and_respond(
        "error",
        `Gemini API error in preprocessing. Skipping preprocessing. ${error}`,
      );
    }

    googleUsage = response.usageMetadata;
    if (!response?.text) {
      return log_update_and_respond(
        "error",
        "No response text received from the preprocessing model. Skipping preprocessing.",
      );
    }

    try {
      result = JSON.parse(response.text);
    } catch (_error) {
      return log_update_and_respond(
        "error",
        "Failed to parse the response text from the preprocessing model into a JSON object. Skipping preprocessing.",
      );
    }
  }

  if (googleUsage) {
    let cost = 0;

    if (costs) {
      cost = calculateCost(
        googleUsage,
        costs.pricing as Record<string, number>,
        costs.quantity,
      );
    }

    await client
      .schema("billing")
      .from("ledger")
      .insert({
        organization_id: org.id,
        product_id: "ai_credits",
        type: "consumption",
        quantity: -cost,
        provider: "google",
        model,
        billable,
        metadata: googleUsage as Json,
      })
      .throwOnError();
  }

  const artifacts: Part[] = [];

  if (result.description) {
    artifacts.push({
      type: "text",
      kind: "description",
      text: result.description,
    });
  }

  // PDF transcription exceeding 2KB
  if (
    mimeType === "application/pdf" &&
    result.transcription &&
    result.transcription.length > MAX_SMALL_DOCUMENT_SIZE
  ) {
    // Store enriched documents (PDF) transcription as llm.txt
    const name = [content.file.name, "llm.txt"].join(".");

    const file = new Blob([result.transcription], {
      type: "text/markdown",
    });

    const uri = await uploadToStorage(client, org.id, file);

    artifacts.push({
      type: "file",
      kind: "document",
      file: { mime_type: file.type, uri, name, size: file.size },
    });

    result.transcription = undefined;
  }

  if (
    result.transcription &&
    // Do not store the transcription for text documents safeguard
    (mediaType !== "document" || mimeType === "application/pdf")
  ) {
    artifacts.push({
      type: "text",
      kind: "transcription",
      text: result.transcription,
    });
  }

  // Do not create a CSV from a CSV safeguard
  if (result.table?.length && mimeType !== "text/csv") {
    const csv = stringify(result.table);

    const name = [content.file.name, "csv"].join(".");

    const file = new Blob([csv], {
      type: "text/csv",
    });

    const uri = await uploadToStorage(client, org.id, file);

    artifacts.push({
      type: "file",
      kind: "document",
      file: { mime_type: file.type, uri, name, size: file.size },
    });
  }

  const preprocessed = {
    ...incoming,
    content: {
      ...content,
      artifacts,
    },
    status: {
      ...status,
      preprocessed: new Date().toISOString(),
    },
  };

  await client
    .from("messages")
    .update(preprocessed)
    .eq("id", incoming.id)
    .throwOnError();

  return new Response();
});
