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
const CHUNK_SIZE = 1_200;
const CHUNK_OVERLAP = 160;
const KNOWLEDGE_GEMINI_MODEL = "gemini-2.5-flash";

type AppEnv = ManagementEnv;
type KnowledgeDocumentInput = {
  organization_id?: string;
  knowledge_base_id?: string;
  storage_path?: string;
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

function extension(fileName: string): string {
  return fileName.split(".").pop()?.toLowerCase() ?? "";
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
    .replace(/\u0000/g, "")
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
    const text = normalizeText(new TextDecoder().decode(bytes));
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

    const { data: file, error: downloadError } = await client.storage
      .from("knowledge")
      .download(document.storage_path);
    if (downloadError || !file) {
      throw downloadError || new Error("Arquivo não encontrado");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length > MAX_FILE_SIZE) {
      throw new Error("O arquivo excede o limite de 20 MB");
    }

    const config = await organizationMediaConfig(document.organization_id);
    const extraction = await extractFile(
      bytes,
      document.file_name,
      document.mime_type,
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
    const storagePath = requireText(payload.storage_path, "storage_path", 500);
    const fileName = requireText(payload.file_name, "file_name", 255);
    const mimeType = requireText(
      payload.mime_type || "application/octet-stream",
      "mime_type",
      160,
    );
    const fileSize = payload.file_size ?? 0;

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
        file_size: fileSize,
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
    await client.storage.from("knowledge").remove([document.storage_path]);
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
