import OpenAI from "openai";

const missingConfigurationMessage =
  "OpenAI is not configured. Connect the managed AI integration or add OPENAI_API_KEY as a workspace secret.";

export function getOpenAIClient(): OpenAI {
  const apiKey =
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY;
  const baseURL =
    process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ??
    process.env.OPENAI_BASE_URL ??
    "https://api.openai.com/v1";

  if (!apiKey) {
    throw new Error(missingConfigurationMessage);
  }

  return new OpenAI({ apiKey, baseURL });
}

export const openaiVisionModel = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL
  ? "gpt-5.6-luna"
  : "gpt-4o-mini";
