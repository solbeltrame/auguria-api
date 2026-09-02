import { extractHtmlText } from "./html.ts";

Deno.test("extracts useful HTML and ignores scripts and styles", () => {
  const result = extractHtmlText(`
    <html><head>
      <title>Estica — Alongamento</title>
      <meta name="description" content="Movimente sua vida">
      <style>.framer-text { font-family: Poppins; color: red; }</style>
      <script>window.secret = "not content";</script>
    </head><body>
      <h1>Primeiro estúdio de alongamento do Brasil</h1>
      <script type="application/json">{"full_name":"Estica","biography":"Transforme seu corpo"}</script>
    </body></html>
  `);

  if (!result.includes("Título: Estica — Alongamento")) {
    throw new Error(`Missing title: ${result}`);
  }
  if (!result.includes("Descrição: Movimente sua vida")) {
    throw new Error(`Missing description: ${result}`);
  }
  if (!result.includes("Nome: Estica")) {
    throw new Error(`Missing structured name: ${result}`);
  }
  if (!result.includes("Biografia: Transforme seu corpo")) {
    throw new Error(`Missing structured biography: ${result}`);
  }
  if (result.includes("font-family") || result.includes("window.secret")) {
    throw new Error(`Script or style leaked: ${result}`);
  }
  if (!result.includes("Primeiro estúdio de alongamento do Brasil")) {
    throw new Error(`Missing body text: ${result}`);
  }
});
