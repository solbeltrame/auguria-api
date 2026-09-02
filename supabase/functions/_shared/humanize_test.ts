import {
  AGENT_RESPONSE_POLICY,
  cleanAgentReply,
  humanizeText,
} from "./humanize.ts";

Deno.test("remove markdown noise and keep human-readable bullets", () => {
  const result = humanizeText(
    "***\n# Estica\n**Alongamento**\n\n* 25 minutos\n- R$ **60,61** por sessão",
  );
  if (result !== "Estica\nAlongamento\n\n• 25 minutos\n• R$ 60,61 por sessão") {
    throw new Error(`Unexpected text: ${result}`);
  }
});

Deno.test("turn markdown tables into readable sentences", () => {
  const result = humanizeText(
    "| Duração | Preço |\n| :--- | ---: |\n| **25 minutos** | R$ **60,61** |",
  );
  if (result !== "• Duração: 25 minutos; Preço: R$ 60,61") {
    throw new Error(`Unexpected table: ${result}`);
  }
});

Deno.test("cleans agent replies and carries identity policy", () => {
  const result = cleanAgentReply(
    "**Nós somos o ChatGPT.**\n\n* Serviço genérico",
  );
  if (result !== "Nós somos o ChatGPT.\n\n• Serviço genérico") {
    throw new Error(`Unexpected reply: ${result}`);
  }
  if (!AGENT_RESPONSE_POLICY.includes("nunca sobre você")) {
    throw new Error("Identity policy is missing");
  }
});
