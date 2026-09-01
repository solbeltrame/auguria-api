import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Hono } from "@hono/hono";
import { cors } from "jsr:@hono/hono/cors";
import { HTTPException } from "jsr:@hono/hono/http-exception";
import JSZip from "npm:jszip@3.10.1";
import { GoogleGenAI } from "@google/genai";
import { encodeBase64 } from "jsr:@std/encoding/base64";
import * as log from "../_shared/logger.ts";
import {
  createApiClient,
  createClient,
  createUnsecureClient,
  type Json,
  type KnowledgeDocumentRow,
} from "../_shared/supabase.ts";
import {
  type ManagementEnv,
  requireRoles,
} from "../_shared/management_auth.ts";

const MAX_FILE_SIZE = 20 * 1000 * 1000;
const MAX_EXTRACTED_TEXT = 2_000_000;
const MAX_INSTRUCTIONS = 60_000;
const MAX_SYNTHESIS_SOURCE = 140_000;
const CHUNK_SIZE = 1_200;
const CHUNK_OVERLAP = 160;
const KNOWLEDGE_GEMINI_MODEL = "gemini-2.5-flash";

type AppEnv = ManagementEnv;
type KnowledgeDocumentInput = {
  organization_id?: string;
  knowledge_base_id?: string;
  source_type?: "file" | "url";
  storage_path?: string;
  source_url?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

type ExtractionResult = {
  text: string;
  method: "text" | "office-xml" | "pdf-text" | "gemini";
  description?: string;
};

const app = new Hono<AppEnv>();

app.use("*", cors());

app.onError((error, c) => {
  if (error instanceof HTTPException) {
    log.error(`${c.req.method} ${c.req.path} → ${error.status}`, error.cause);
    return c.json({ message: error.message }, error.status);
  }

  log.error(`Unhandled error on ${c.req.method} ${c.req.path}`, error);
  return c.json({ message: "Internal Server Error" }, 500);
});

app.use("*", async (c, next) => {
  const token = c.req.header("Authorization")?.replace("Bearer ", "");
  if (!token) {
    throw new HTTPException(401, { message: "Missing authorization token" });
  }

  c.set("token", token);

  if (token.startsWith("eyJ")) {
    const client = createClient(c.req.raw);
    const { data: { user }, error } = await client.auth.getUser();
    if (error || !user) {
      throw new HTTPException(401, { message: "Invalid JWT", cause: error });
    }
    c.set("user", user);
    c.set("supabase", client);
    await next();
    return;
  }

  const client = createApiClient(c.req.raw);
  const { data: apiKey, error } = await client
    .from("api_keys")
    .select()
    .eq("key", token)
    .maybeSingle();

  if (error || !apiKey) {
    throw new HTTPException(401, { message: "Invalid API key", cause: error });
  }

  c.set("apiKey", apiKey);
  c.set("supabase", client);
  await next();
});

function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HTTPException(400, { message: `${field} is required` });
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new HTTPException(400, { message: `${field} is too long` });
  }
  return normalized;
}

function validateSourceUrl(value: unknown): string {
  const sourceUrl = requireText(value, "source_url", 2_000);
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new HTTPException(400, { message: "source_url must be a valid URL" });
  }

  const hostname = parsed.hostname.toLowerCase();
  const privateHost = hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "::1" ||
    hostname.startsWith("127.") ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname) ||
    hostname.startsWith("169.254.");

  if (!(["http:", "https:"].includes(parsed.protocol)) || privateHost) {
    throw new HTTPException(400, {
      message: "source_url must use a public HTTP or HTTPS address",
    });
  }
  if (parsed.username || parsed.password) {
    throw new HTTPException(400, {
      message: "source_url cannot contain credentials",
    });
  }
  return parsed.toString();
}

function extension(fileName: string): string {
  return fileName.split(".").pop()?.toLowerCase() ?? "";
}

function safeStorageFileName(fileName: string): string {
  const normalized = fileName
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
  return normalized || "arquivo";
}

function mimeFromName(fileName: string, mimeType: string): string {
  if (mimeType && mimeType !== "application/octet-stream") return mimeType;

  const byExtension: Record<string, string> = {
    bmp: "image/bmp",
    csv: "text/csv",
    doc: "application/msword",
    docx:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    html: "text/html",
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    json: "application/json",
    md: "text/markdown",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    mov: "video/quicktime",
    pdf: "application/pdf",
    png: "image/png",
    ogg: "audio/ogg",
    pptx:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain",
    tiff: "image/tiff",
    tif: "image/tiff",
    wav: "audio/wav",
    webp: "image/webp",
    webm: "video/webm",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
  };

  return byExtension[extension(fileName)] ?? mimeType ??
    "application/octet-stream";
}

function decodeXml(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(
      /&#(\d+);/g,
      (_, code: string) => String.fromCodePoint(Number(code)),
    )
    .replace(
      /&#x([\da-f]+);/gi,
      (_, code: string) => String.fromCodePoint(parseInt(code, 16)),
    )
    .replace(/[ \t\r\n]+/g, " ")
    .trim();
}

function normalizeText(value: string): string {
  return value
    .replaceAll(String.fromCharCode(0), "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_EXTRACTED_TEXT);
}

function splitIntoChunks(value: string): string[] {
  const text = normalizeText(value);
  if (!text) return [];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(text.length, start + CHUNK_SIZE);
    if (end < text.length) {
      const boundary = Math.max(
        text.lastIndexOf("\n", end),
        text.lastIndexOf(".", end),
        text.lastIndexOf(" ", end),
      );
      if (boundary > start + Math.floor(CHUNK_SIZE * 0.55)) end = boundary + 1;
    }

    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= text.length) break;
    start = Math.max(start + 1, end - CHUNK_OVERLAP);
  }

  return chunks;
}

async function extractOfficeXml(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).filter((name) => {
    if (zip.files[name]?.dir) return false;
    return /^(word\/document\.xml|ppt\/slides\/slide\d+\.xml|xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml))$/i
      .test(name);
  }).sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true })
  );

  const sharedStrings: string[] = [];
  const sharedStringsFile = zip.file("xl/sharedStrings.xml");
  if (sharedStringsFile) {
    const xml = await sharedStringsFile.async("text");
    for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)) {
      sharedStrings.push(decodeXml(match[1] ?? ""));
    }
  }

  const parts: string[] = [];
  for (const name of names) {
    const file = zip.file(name);
    if (!file) continue;
    const xml = await file.async("text");

    if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(name)) {
      const rows: string[] = [];
      for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
        const values: string[] = [];
        for (
          const cellMatch of (rowMatch[1] ?? "").matchAll(
            /<c\b([^>]*)>([\s\S]*?)<\/c>/gi,
          )
        ) {
          const attributes = cellMatch[1] ?? "";
          const body = cellMatch[2] ?? "";
          const type = attributes.match(/\bt=["']([^"']+)["']/i)?.[1];
          const value = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1] ??
            body.match(/<t\b[^>]*>([\s\S]*?)<\/t>/i)?.[1] ??
            "";
          if (type === "s") {
            values.push(sharedStrings[Number(value)] ?? value);
          } else {
            values.push(decodeXml(value));
          }
        }
        if (values.length) rows.push(values.join(" | "));
      }
      if (rows.length) parts.push(rows.join("\n"));
      continue;
    }

    if (!/^xl\/sharedStrings\.xml$/i.test(name)) {
      parts.push(decodeXml(xml));
    }
  }

  return normalizeText(parts.join("\n"));
}

function bytesAsBinary(bytes: Uint8Array): string {
  let value = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    value += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return value;
}

function decodePdfBytes(bytes: number[]): string {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let value = "";
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      value += String.fromCharCode((bytes[index] << 8) | bytes[index + 1]);
    }
    return value;
  }

  return new TextDecoder("windows-1252").decode(Uint8Array.from(bytes));
}

function decodePdfLiteral(value: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code !== 92) {
      bytes.push(code & 0xff);
      continue;
    }

    const next = value[index + 1];
    if (!next) break;
    const escapes: Record<string, number> = {
      b: 8,
      f: 12,
      n: 10,
      r: 13,
      t: 9,
    };
    if (next in escapes) {
      bytes.push(escapes[next]);
      index++;
      continue;
    }

    if (/[0-7]/.test(next)) {
      const octal = value.slice(index + 1).match(/^[0-7]{1,3}/)?.[0] ?? "";
      bytes.push(parseInt(octal, 8));
      index += octal.length;
      continue;
    }

    bytes.push(next.charCodeAt(0) & 0xff);
    index++;
  }
  return decodePdfBytes(bytes);
}

function decodePdfHex(value: string): string {
  const compact = value.replace(/\s/g, "");
  const bytes: number[] = [];
  for (let index = 0; index < compact.length; index += 2) {
    bytes.push(parseInt(compact.slice(index, index + 2).padEnd(2, "0"), 16));
  }
  return decodePdfBytes(bytes);
}

function extractPdfOperators(source: string): string {
  const parts: string[] = [];
  const textPattern = /\(((?:\\.|[^\\)])*)\)\s*(?:Tj|['"])/g;
  for (const match of source.matchAll(textPattern)) {
    const text = decodePdfLiteral(match[1] ?? "").trim();
    if (text) parts.push(text);
  }

  const arrayPattern = /\[([\s\S]*?)\]\s*TJ/g;
  const tokenPattern = /\(((?:\\.|[^\\)])*)\)|<([\da-fA-F\s]+)>/g;
  for (const match of source.matchAll(arrayPattern)) {
    const values: string[] = [];
    for (const token of (match[1] ?? "").matchAll(tokenPattern)) {
      const text = token[1] !== undefined
        ? decodePdfLiteral(token[1])
        : decodePdfHex(token[2] ?? "");
      if (text) values.push(text);
    }
    if (values.length) parts.push(values.join(" ").trim());
  }

  return parts.join(" ");
}

async function inflatePdfStream(bytes: Uint8Array): Promise<Uint8Array> {
  const decompressor = new DecompressionStream("deflate");
  const writer = decompressor.writable.getWriter();
  await writer.write(bytes as unknown as Uint8Array<ArrayBuffer>);
  await writer.close();
  return new Uint8Array(
    await new Response(decompressor.readable).arrayBuffer(),
  ) as unknown as Uint8Array;
}

async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const source = bytesAsBinary(bytes);
  const streamTexts: string[] = [];
  let cursor = 0;

  while (true) {
    const marker = source.indexOf("stream", cursor);
    if (marker < 0) break;
    const end = source.indexOf("endstream", marker + 6);
    if (end < 0) break;

    const dictionaryStart = source.lastIndexOf("<<", marker);
    const dictionary = dictionaryStart >= 0
      ? source.slice(dictionaryStart, marker)
      : "";
    let dataStart = marker + 6;
    while (
      dataStart < end &&
      (source[dataStart] === "\r" || source[dataStart] === "\n")
    ) {
      dataStart++;
    }
    let dataEnd = end;
    while (
      dataEnd > dataStart &&
      (source[dataEnd - 1] === "\r" || source[dataEnd - 1] === "\n")
    ) {
      dataEnd--;
    }

    let stream = bytes.slice(dataStart, dataEnd);
    if (/\/FlateDecode\b/.test(dictionary)) {
      try {
        stream = (await inflatePdfStream(stream)) as typeof stream;
      } catch {
        stream = bytes.slice(dataStart, dataEnd);
      }
    }

    const text = extractPdfOperators(bytesAsBinary(stream));
    if (text) streamTexts.push(text);
    cursor = end + 9;
  }

  const rawText = extractPdfOperators(source);
  const streamedText = streamTexts.join("\n");
  return normalizeText(
    streamedText.length > rawText.length ? streamedText : rawText,
  );
}

function isGeminiMedia(mimeType: string): boolean {
  return mimeType.startsWith("image/") || mimeType.startsWith("audio/") ||
    mimeType.startsWith("video/");
}

async function extractWithGemini(
  bytes: Uint8Array,
  mimeType: string,
  fileName: string,
  apiKey: string,
  model: string,
): Promise<ExtractionResult> {
  const genai = new GoogleGenAI({ apiKey });
  const prompt = mimeType.startsWith("audio/")
    ? `Transcreva este áudio em seu idioma original. Identifique falas, nomes, números e informações úteis. Arquivo: ${fileName}.`
    : mimeType.startsWith("image/")
    ? `Leia e descreva esta imagem. Extraia todo texto visível, valores, datas e tabelas de forma organizada. Arquivo: ${fileName}.`
    : `Extraia e organize todo o conteúdo textual deste arquivo. Preserve títulos, listas, tabelas, valores e datas. Arquivo: ${fileName}.`;

  const response = await genai.models.generateContent({
    model,
    contents: [
      { inlineData: { mimeType, data: encodeBase64(bytes) } },
      { text: prompt },
    ],
  });

  const text = normalizeText(response.text ?? "");
  if (!text) {
    throw new Error("O modelo não conseguiu extrair conteúdo do arquivo");
  }
  return { text, method: "gemini" };
}

async function extractFile(
  bytes: Uint8Array,
  fileName: string,
  rawMimeType: string,
  apiKey?: string,
  model = KNOWLEDGE_GEMINI_MODEL,
): Promise<ExtractionResult> {
  const mimeType = mimeFromName(fileName, rawMimeType);
  const fileExtension = extension(fileName);

  if (isGeminiMedia(mimeType)) {
    if (!apiKey) {
      throw new Error(
        "Este tipo de arquivo precisa de uma chave Google/Gemini para transcrição ou leitura visual",
      );
    }
    return await extractWithGemini(bytes, mimeType, fileName, apiKey, model);
  }

  if (mimeType === "application/pdf" || fileExtension === "pdf") {
    const text = await extractPdfText(bytes);
    if (text.length >= 20) return { text, method: "pdf-text" };
    if (!apiKey) {
      throw new Error(
        "Este PDF parece ser escaneado. Configure uma chave Google/Gemini para leitura visual",
      );
    }
    return await extractWithGemini(bytes, mimeType, fileName, apiKey, model);
  }

  if (
    fileExtension === "docx" ||
    fileExtension === "pptx" ||
    fileExtension === "xlsx" ||
    mimeType.includes("wordprocessingml") ||
    mimeType.includes("presentationml") ||
    mimeType.includes("spreadsheetml")
  ) {
    const text = await extractOfficeXml(bytes);
    if (!text) {
      throw new Error("Não encontrei texto legível neste arquivo Office");
    }
    return { text, method: "office-xml" };
  }

  if (
    mimeType.startsWith("text/") ||
    ["csv", "json", "md", "markdown", "xml", "html", "rtf", "sql"].includes(
      fileExtension,
    )
  ) {
    const decoded = new TextDecoder().decode(bytes);
    const text = normalizeText(
      mimeType === "text/html" ? decodeXml(decoded) : decoded,
    );
    if (!text) throw new Error("O arquivo de texto está vazio");
    return { text, method: "text" };
  }

  if (apiKey) {
    return await extractWithGemini(bytes, mimeType, fileName, apiKey, model);
  }
  throw new Error(`Formato não suportado sem Google/Gemini: ${mimeType}`);
}

async function organizationMediaConfig(organizationId: string): Promise<{
  apiKey?: string;
  model?: string;
}> {
  const client = createUnsecureClient();
  const { data } = await client
    .from("organizations")
    .select("extra")
    .eq("id", organizationId)
    .single()
    .throwOnError();

  const extra = data.extra as {
    media_preprocessing?: { api_key?: string; model?: string };
  } | null;
  return {
    apiKey: extra?.media_preprocessing?.api_key ||
      Deno.env.get("GOOGLE_API_KEY") || undefined,
    model: extra?.media_preprocessing?.model || KNOWLEDGE_GEMINI_MODEL,
  };
}

async function downloadDocumentSource(document: KnowledgeDocumentRow): Promise<{
  bytes: Uint8Array;
  mimeType: string;
}> {
  if (document.source_type === "url") {
    if (!document.source_url) throw new Error("A fonte não possui uma URL");
    const response = await fetch(document.source_url, {
      headers: { accept: "text/html,text/plain,application/json,*/*" },
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error("A URL redirecionou; cadastre o endereço final da fonte");
    }
    if (!response.ok) {
      throw new Error(`A URL respondeu com HTTP ${response.status}`);
    }
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_FILE_SIZE) {
      throw new Error("O conteúdo remoto excede o limite de 20 MB");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_FILE_SIZE) {
      throw new Error("O conteúdo remoto excede o limite de 20 MB");
    }
    return {
      bytes,
      mimeType: response.headers.get("content-type")?.split(";", 1)[0] ||
        document.mime_type,
    };
  }

  if (!document.storage_path) throw new Error("O arquivo não possui storage");
  const client = createUnsecureClient();
  const { data: file, error: downloadError } = await client.storage
    .from("knowledge")
    .download(document.storage_path);
  if (downloadError || !file) {
    throw downloadError || new Error("Arquivo não encontrado");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { bytes, mimeType: document.mime_type };
}

async function processDocument(
  document: KnowledgeDocumentRow,
): Promise<KnowledgeDocumentRow> {
  const client = createUnsecureClient();
  try {
    await client
      .from("knowledge_documents")
      .update({ status: "processing", error_message: null })
      .eq("id", document.id)
      .throwOnError();

    const source = await downloadDocumentSource(document);
    const bytes = source.bytes;
    if (bytes.length > MAX_FILE_SIZE) {
      throw new Error("O arquivo excede o limite de 20 MB");
    }

    const config = await organizationMediaConfig(document.organization_id);
    const extraction = await extractFile(
      bytes,
      document.file_name,
      source.mimeType,
      config.apiKey,
      config.model,
    );
    const chunks = splitIntoChunks(extraction.text);
    if (!chunks.length) {
      throw new Error("Não foi possível gerar trechos para indexação");
    }

    await client
      .from("knowledge_chunks")
      .delete()
      .eq("document_id", document.id)
      .throwOnError();

    const rows = chunks.map((content, chunkIndex) => ({
      organization_id: document.organization_id,
      knowledge_base_id: document.knowledge_base_id,
      document_id: document.id,
      chunk_index: chunkIndex,
      content,
      metadata: {
        file_name: document.file_name,
        ...(document.source_url && { source_url: document.source_url }),
        method: extraction.method,
      } as Json,
    }));

    for (let index = 0; index < rows.length; index += 100) {
      await client.from("knowledge_chunks").insert(
        rows.slice(index, index + 100),
      ).throwOnError();
    }

    const metadata = {
      ...(document.metadata as Record<string, unknown>),
      extraction_method: extraction.method,
      chunk_count: chunks.length,
      indexed_at: new Date().toISOString(),
    } as Json;

    const { data: updated } = await client
      .from("knowledge_documents")
      .update({
        status: "ready",
        mime_type: source.mimeType,
        extracted_text: extraction.text,
        metadata,
        error_message: null,
      })
      .eq("id", document.id)
      .select()
      .single()
      .throwOnError();

    return updated;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await client
      .from("knowledge_documents")
      .update({ status: "error", error_message: message })
      .eq("id", document.id);
    throw error;
  }
}

type SynthesisDocument = Pick<
  KnowledgeDocumentRow,
  "file_name" | "extracted_text" | "source_type" | "source_url"
>;

function normalizeInstructions(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, MAX_INSTRUCTIONS);
}

function sourceForSynthesis(
  documents: SynthesisDocument[],
): string {
  const sections: string[] = [];

  for (const document of documents) {
    const extracted = normalizeText(document.extracted_text ?? "");
    if (!extracted) continue;
    const source = document.source_url ? `\nURL: ${document.source_url}` : "";
    sections.push(
      `## Fonte: ${document.file_name}${source}\n${extracted.slice(0, 30_000)}`,
    );
  }

  return sections.join("\n\n").slice(0, MAX_SYNTHESIS_SOURCE);
}

function compiledInstructions(
  documents: SynthesisDocument[],
): string {
  const source = sourceForSynthesis(documents);
  if (!source) return "";

  return [
    "# Contexto consolidado do negócio",
    "",
    "Use este documento como referência operacional. Preserve fatos, preços, horários, políticas e exceções. Quando algo não estiver aqui, peça confirmação em vez de inventar.",
    "",
    source,
  ].join("\n").slice(0, MAX_INSTRUCTIONS);
}

async function synthesizeInstructions(
  documents: SynthesisDocument[],
  config: { apiKey?: string; model?: string },
): Promise<string> {
  const fallback = compiledInstructions(documents);
  const source = sourceForSynthesis(documents);
  if (!config.apiKey || !source) {
    return fallback;
  }

  try {
    const genai = new GoogleGenAI({ apiKey: config.apiKey });
    const response = await genai.models.generateContent({
      model: config.model || KNOWLEDGE_GEMINI_MODEL,
      contents: [{
        text: [
          "Você é o editor da base de conhecimento de uma empresa.",
          "Consolide as fontes abaixo em um único documento Markdown em português do Brasil para orientar um agente de atendimento.",
          "Remova duplicações, preserve números, preços, nomes, horários, regras e exceções, e sinalize conflitos sem escolher um lado.",
          "Não invente informações, não escreva prefácio nem explique o processo.",
          "Organize o resultado em: identidade e escopo, produtos/serviços, políticas e regras, operação e atendimento, perguntas frequentes e casos de exceção.",
          "\nFONTES:\n",
          source,
        ].join("\n"),
      }],
      config: {
        temperature: 0.15,
        maxOutputTokens: 12_000,
      },
    });
    const generated = normalizeInstructions(response.text);
    return generated || fallback;
  } catch (error) {
    log.warn("Knowledge synthesis failed; keeping compiled context", error);
    return fallback;
  }
}

app.get(
  "/knowledge-management/bases",
  requireRoles(["member", "admin", "owner"]),
  async (c) => {
    const organizationId = c.req.query("organization_id");
    const client = c.get("supabase");
    const { data } = await client
      .from("knowledge_bases")
      .select()
      .eq("organization_id", organizationId!)
      .order("updated_at", { ascending: false })
      .throwOnError();
    return c.json(data);
  },
);

app.post(
  "/knowledge-management/bases/default",
  requireRoles(["admin", "owner"]),
  async (c) => {
    const payload = await c.req.json<{ organization_id?: string }>();
    const organizationId = requireText(
      payload.organization_id,
      "organization_id",
      80,
    );
    const client = createUnsecureClient();
    const { data: existing } = await client
      .from("knowledge_bases")
      .select()
      .eq("organization_id", organizationId)
      .order("updated_at", { ascending: false })
      .limit(1)
      .throwOnError();
    if (existing[0]) return c.json(existing[0]);

    const { data } = await client
      .from("knowledge_bases")
      .insert({
        organization_id: organizationId,
        name: "Base de conhecimento",
        description: "Arquivos e orientações consolidadas da organização.",
        instructions: "",
        created_by: c.get("user")?.id ?? null,
      })
      .select()
      .single()
      .throwOnError();
    return c.json(data, 201);
  },
);

app.post(
  "/knowledge-management/bases",
  requireRoles(["admin", "owner"]),
  async (c) => {
    const payload = await c.req.json<
      { organization_id?: string; name?: string; description?: string }
    >();
    const organizationId = requireText(
      payload.organization_id,
      "organization_id",
      80,
    );
    const name = requireText(payload.name, "name", 120);
    const description = payload.description?.trim() || null;
    const client = createUnsecureClient();
    const { data } = await client
      .from("knowledge_bases")
      .insert({
        organization_id: organizationId,
        name,
        description,
        instructions: "",
        created_by: c.get("user")?.id ?? null,
      })
      .select()
      .single()
      .throwOnError();
    return c.json(data, 201);
  },
);

app.patch(
  "/knowledge-management/bases/:id",
  requireRoles(["admin", "owner"]),
  async (c) => {
    const payload = await c.req.json<
      {
        organization_id?: string;
        name?: string;
        description?: string | null;
        instructions?: string;
        status?: "active" | "archived";
      }
    >();
    const organizationId = requireText(
      payload.organization_id,
      "organization_id",
      80,
    );
    const baseId = requireText(c.req.param("id"), "id", 80);
    const patch: Record<string, unknown> = {};
    if (payload.name !== undefined) {
      patch.name = requireText(payload.name, "name", 120);
    }
    if (payload.description !== undefined) {
      patch.description = payload.description?.trim() || null;
    }
    if (payload.instructions !== undefined) {
      if (typeof payload.instructions !== "string") {
        throw new HTTPException(400, { message: "instructions must be text" });
      }
      if (payload.instructions.length > MAX_INSTRUCTIONS) {
        throw new HTTPException(400, {
          message:
            `instructions must be at most ${MAX_INSTRUCTIONS} characters`,
        });
      }
      patch.instructions = payload.instructions.trim();
    }
    if (payload.status !== undefined) patch.status = payload.status;
    if (!Object.keys(patch).length) {
      throw new HTTPException(400, { message: "No changes provided" });
    }
    const client = createUnsecureClient();
    const { data } = await client
      .from("knowledge_bases")
      .update(patch)
      .eq("id", baseId)
      .eq("organization_id", organizationId)
      .select()
      .single()
      .throwOnError();
    return c.json(data);
  },
);

app.post(
  "/knowledge-management/bases/:id/synthesize",
  requireRoles(["admin", "owner"]),
  async (c) => {
    const organizationId = requireText(
      c.req.query("organization_id"),
      "organization_id",
      80,
    );
    const baseId = requireText(c.req.param("id"), "id", 80);
    const client = createUnsecureClient();
    const { data: base } = await client
      .from("knowledge_bases")
      .select()
      .eq("id", baseId)
      .eq("organization_id", organizationId)
      .maybeSingle()
      .throwOnError();
    if (!base) {
      throw new HTTPException(404, { message: "Knowledge base not found" });
    }

    const { data: documents } = await client
      .from("knowledge_documents")
      .select("file_name, extracted_text, source_type, source_url")
      .eq("knowledge_base_id", baseId)
      .eq("organization_id", organizationId)
      .eq("status", "ready")
      .eq("active", true)
      .order("created_at", { ascending: true })
      .throwOnError();
    const mediaConfig = await organizationMediaConfig(organizationId);
    const instructions = await synthesizeInstructions(
      documents,
      mediaConfig,
    );
    const { data: updated } = await client
      .from("knowledge_bases")
      .update({ generated_context: instructions })
      .eq("id", baseId)
      .eq("organization_id", organizationId)
      .select()
      .single()
      .throwOnError();
    return c.json(updated);
  },
);

app.post(
  "/knowledge-management/bases/:id/duplicate",
  requireRoles(["admin", "owner"]),
  async (c) => {
    const payload = await c.req.json<{
      organization_id?: string;
      name?: string;
      description?: string | null;
    }>();
    const organizationId = requireText(
      payload.organization_id,
      "organization_id",
      80,
    );
    const sourceBaseId = requireText(c.req.param("id"), "id", 80);
    const name = requireText(payload.name, "name", 120);
    const description = payload.description?.trim() || null;
    const client = createUnsecureClient();
    const { data: sourceBase } = await client
      .from("knowledge_bases")
      .select()
      .eq("id", sourceBaseId)
      .eq("organization_id", organizationId)
      .maybeSingle()
      .throwOnError();
    if (!sourceBase) {
      throw new HTTPException(404, { message: "Knowledge base not found" });
    }

    const { data: sourceDocuments } = await client
      .from("knowledge_documents")
      .select()
      .eq("organization_id", organizationId)
      .eq("knowledge_base_id", sourceBaseId)
      .order("created_at", { ascending: true })
      .throwOnError();

    const { data: duplicatedBase } = await client
      .from("knowledge_bases")
      .insert({
        organization_id: organizationId,
        name,
        description: description ?? sourceBase.description,
        instructions: sourceBase.instructions,
        generated_context: sourceBase.generated_context,
        status: "active",
        created_by: c.get("user")?.id ?? null,
      })
      .select()
      .single()
      .throwOnError();

    for (const sourceDocument of sourceDocuments) {
      let storagePath: string | null = null;
      let fileSize = sourceDocument.file_size;
      let mimeType = sourceDocument.mime_type;

      if (sourceDocument.source_type !== "url") {
        const source = await downloadDocumentSource(sourceDocument);
        mimeType = source.mimeType;
        fileSize = source.bytes.length;
        storagePath = [
          organizationId,
          duplicatedBase.id,
          `${crypto.randomUUID()}-${
            safeStorageFileName(sourceDocument.file_name)
          }`,
        ].join("/");
        const { error: uploadError } = await client.storage
          .from("knowledge")
          .upload(
            storagePath,
            new Blob([source.bytes.buffer as ArrayBuffer], { type: mimeType }),
            { upsert: false, contentType: mimeType },
          );
        if (uploadError) throw uploadError;
      }

      const { data: duplicatedDocument } = await client
        .from("knowledge_documents")
        .insert({
          organization_id: organizationId,
          knowledge_base_id: duplicatedBase.id,
          file_name: sourceDocument.file_name,
          mime_type: mimeType,
          storage_path: storagePath,
          source_type: sourceDocument.source_type,
          source_url: sourceDocument.source_url,
          file_size: fileSize,
          status: "pending",
          active: sourceDocument.active,
          metadata: sourceDocument.metadata,
          created_by: c.get("user")?.id ?? null,
        })
        .select()
        .single()
        .throwOnError();

      try {
        await processDocument(duplicatedDocument);
      } catch (error) {
        log.warn("Knowledge source duplication failed", {
          source_document_id: sourceDocument.id,
          duplicated_base_id: duplicatedBase.id,
          error,
        });
      }
    }

    return c.json(duplicatedBase, 201);
  },
);

app.delete(
  "/knowledge-management/bases/:id",
  requireRoles(["admin", "owner"]),
  async (c) => {
    const organizationId = requireText(
      c.req.query("organization_id"),
      "organization_id",
      80,
    );
    const baseId = requireText(c.req.param("id"), "id", 80);
    const client = createUnsecureClient();
    const { data: files } = await client.storage.from("knowledge").list(
      `${organizationId}/${baseId}`,
    );
    if (files?.length) {
      await client.storage.from("knowledge").remove(
        files.map((file) => `${organizationId}/${baseId}/${file.name}`),
      );
    }
    await client
      .from("knowledge_bases")
      .delete()
      .eq("id", baseId)
      .eq("organization_id", organizationId)
      .throwOnError();
    return c.body(null, 204);
  },
);

app.get(
  "/knowledge-management/documents",
  requireRoles(["member", "admin", "owner"]),
  async (c) => {
    const organizationId = c.req.query("organization_id");
    const baseId = c.req.query("knowledge_base_id");
    const client = c.get("supabase");
    let query = client
      .from("knowledge_documents")
      .select()
      .eq("organization_id", organizationId!)
      .order("created_at", { ascending: false });
    if (baseId) query = query.eq("knowledge_base_id", baseId);
    const { data } = await query.throwOnError();
    return c.json(data);
  },
);

app.post(
  "/knowledge-management/documents",
  requireRoles(["admin", "owner"]),
  async (c) => {
    const payload = await c.req.json<KnowledgeDocumentInput>();
    const organizationId = requireText(
      payload.organization_id,
      "organization_id",
      80,
    );
    const baseId = requireText(
      payload.knowledge_base_id,
      "knowledge_base_id",
      80,
    );
    const sourceType = payload.source_type ||
      (payload.source_url ? "url" : "file");
    if (sourceType !== "file" && sourceType !== "url") {
      throw new HTTPException(400, {
        message: "source_type must be file or url",
      });
    }

    let storagePath: string | null = null;
    let sourceUrl: string | null = null;
    let fileName: string;
    let mimeType: string;
    let fileSize: number;

    if (sourceType === "url") {
      sourceUrl = validateSourceUrl(payload.source_url);
      fileName = payload.file_name?.trim() || new URL(sourceUrl).hostname;
      if (fileName.length > 255) {
        throw new HTTPException(400, { message: "file_name is too long" });
      }
      mimeType = requireText(
        payload.mime_type || "text/html",
        "mime_type",
        160,
      );
      fileSize = 0;
    } else {
      storagePath = requireText(payload.storage_path, "storage_path", 500);
      fileName = requireText(payload.file_name, "file_name", 255);
      mimeType = requireText(
        payload.mime_type || "application/octet-stream",
        "mime_type",
        160,
      );
      fileSize = payload.file_size ?? 0;

      if (!storagePath.startsWith(`${organizationId}/${baseId}/`)) {
        throw new HTTPException(400, {
          message: "storage_path does not belong to this organization/base",
        });
      }
      const pathParts = storagePath.split("/");
      if (
        pathParts.length !== 3 ||
        pathParts.some((part) => !part || part === "." || part === "..")
      ) {
        throw new HTTPException(400, { message: "Invalid storage_path" });
      }
      if (
        !Number.isInteger(fileSize) || fileSize < 1 || fileSize > MAX_FILE_SIZE
      ) {
        throw new HTTPException(400, {
          message: `file_size must be between 1 and ${MAX_FILE_SIZE} bytes`,
        });
      }
    }

    const client = createUnsecureClient();
    const { data: base } = await client
      .from("knowledge_bases")
      .select("id")
      .eq("id", baseId)
      .eq("organization_id", organizationId)
      .maybeSingle()
      .throwOnError();
    if (!base) {
      throw new HTTPException(404, { message: "Knowledge base not found" });
    }

    const { data: document } = await client
      .from("knowledge_documents")
      .insert({
        organization_id: organizationId,
        knowledge_base_id: baseId,
        file_name: fileName,
        mime_type: mimeType,
        storage_path: storagePath,
        source_type: sourceType,
        source_url: sourceUrl,
        file_size: fileSize,
        active: true,
        status: "pending",
        created_by: c.get("user")?.id ?? null,
      })
      .select()
      .single()
      .throwOnError();

    try {
      const processed = await processDocument(document);
      return c.json(processed, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("Knowledge document processing failed", {
        document_id: document.id,
        message,
      });
      return c.json(
        { ...document, status: "error", error_message: message },
        422,
      );
    }
  },
);

app.post(
  "/knowledge-management/documents/:id/reprocess",
  requireRoles(["admin", "owner"]),
  async (c) => {
    const organizationId = requireText(
      c.req.query("organization_id"),
      "organization_id",
      80,
    );
    const documentId = requireText(c.req.param("id"), "id", 80);
    const client = createUnsecureClient();
    const { data: document } = await client
      .from("knowledge_documents")
      .select()
      .eq("id", documentId)
      .eq("organization_id", organizationId)
      .maybeSingle()
      .throwOnError();

    if (!document) {
      throw new HTTPException(404, { message: "Knowledge document not found" });
    }
    if (document.status !== "error") {
      throw new HTTPException(409, {
        message: "Only documents with an error can be reprocessed",
      });
    }

    try {
      return c.json(await processDocument(document));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("Knowledge document reprocessing failed", {
        document_id: document.id,
        message,
      });
      return c.json(
        { ...document, status: "error", error_message: message },
        422,
      );
    }
  },
);

app.patch(
  "/knowledge-management/documents/:id",
  requireRoles(["admin", "owner"]),
  async (c) => {
    const organizationId = requireText(
      c.req.query("organization_id"),
      "organization_id",
      80,
    );
    const documentId = requireText(c.req.param("id"), "id", 80);
    const payload = await c.req.json<{ active?: boolean }>();
    if (typeof payload.active !== "boolean") {
      throw new HTTPException(400, { message: "active must be boolean" });
    }

    const client = createUnsecureClient();
    const { data } = await client
      .from("knowledge_documents")
      .update({ active: payload.active })
      .eq("id", documentId)
      .eq("organization_id", organizationId)
      .select()
      .single()
      .throwOnError();
    return c.json(data);
  },
);

app.delete(
  "/knowledge-management/documents/:id",
  requireRoles(["admin", "owner"]),
  async (c) => {
    const organizationId = requireText(
      c.req.query("organization_id"),
      "organization_id",
      80,
    );
    const documentId = requireText(c.req.param("id"), "id", 80);
    const client = createUnsecureClient();
    const { data: document } = await client
      .from("knowledge_documents")
      .select("storage_path")
      .eq("id", documentId)
      .eq("organization_id", organizationId)
      .maybeSingle()
      .throwOnError();
    if (!document) return c.body(null, 204);
    if (document.storage_path) {
      await client.storage.from("knowledge").remove([document.storage_path]);
    }
    await client
      .from("knowledge_documents")
      .delete()
      .eq("id", documentId)
      .eq("organization_id", organizationId)
      .throwOnError();
    return c.body(null, 204);
  },
);

Deno.serve((request) => app.fetch(request));
