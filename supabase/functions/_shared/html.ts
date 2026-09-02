const MAX_HTML_TEXT = 2_000_000;

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

function decodeJsonString(value: string): string {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value
      .replace(
        /\\u([\da-f]{4})/gi,
        (_, code: string) => String.fromCodePoint(parseInt(code, 16)),
      )
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
}

function normalizeText(value: string, maxLength: number): string {
  return value
    .replaceAll(String.fromCharCode(0), "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLength);
}

export function extractHtmlText(
  value: string,
  maxLength = MAX_HTML_TEXT,
): string {
  const metadata: string[] = [];
  const addMetadata = (label: string, content: string) => {
    const text = decodeXml(content).trim();
    if (text && !metadata.includes(`${label}: ${text}`)) {
      metadata.push(`${label}: ${text}`);
    }
  };

  const title = value.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (title) addMetadata("Título", title);

  const metaLabels: Record<string, string> = {
    description: "Descrição",
    "og:title": "Título",
    "og:description": "Descrição",
    "twitter:title": "Título",
    "twitter:description": "Descrição",
  };
  for (const match of value.matchAll(/<meta\b([^>]*)>/gi)) {
    const tag = match[1] ?? "";
    const key = tag.match(
      /(?:property|name)\s*=\s*["']([^"']+)["']/i,
    )?.[1]?.toLowerCase();
    const content = tag.match(/content\s*=\s*["']([^"']*)["']/i)?.[1];
    const label = key ? metaLabels[key] : undefined;
    if (label && content !== undefined) addMetadata(label, content);
  }

  const structuredLabels: Record<string, string> = {
    full_name: "Nome",
    biography: "Biografia",
    username: "Usuário",
    category_name: "Categoria",
    external_url: "Site externo",
    city_name: "Localização",
  };
  for (
    const match of value.matchAll(
      /"(full_name|biography|username|category_name|external_url|city_name)"\s*:\s*"((?:\\.|[^"\\])*)"/gi,
    )
  ) {
    const label = structuredLabels[match[1]?.toLowerCase() ?? ""];
    if (label && match[2]) addMetadata(label, decodeJsonString(match[2]));
  }

  const visible = value
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  const body = decodeXml(visible);
  return normalizeText(
    [...metadata, body].filter(Boolean).join("\n"),
    maxLength,
  );
}
