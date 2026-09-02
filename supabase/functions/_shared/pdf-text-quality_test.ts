import { isReadablePdfText, keepExpectedPdfPages } from "./pdf-text-quality.ts";

Deno.test("accepts readable PDF text", () => {
  const result = isReadablePdfText(
    "Tabela de preços: sessão de 25 minutos por R$ 80,00 e sessão de 50 minutos por R$ 140,00.",
  );
  if (!result) throw new Error("Readable text was rejected");
});

Deno.test("rejects decoded binary streams", () => {
  const result = isReadablePdfText(
    "záƒä\x11Àd§·mãp5x «[öû€ð\x1bë \x16~óÖ\x8di@Ð´©áEF€ZŽZ@Y\x07¿>0ô\x0e*~QŠ<\x04\x9d\x11 g\x8dgI",
  );
  if (result) throw new Error("Decoded binary stream was accepted");
});

Deno.test("removes pages invented by vision model", () => {
  const result = keepExpectedPdfPages(
    "# Página 1\nTabela de preços\n\n# Página 2\nConteúdo inventado",
    1,
  );
  if (result !== "# Página 1\nTabela de preços") {
    throw new Error("Unexpected PDF pages were preserved");
  }
});
