import OpenAI from "openai";

let directClient: OpenAI | null | undefined;

export function getDirectOpenAIFallback(): OpenAI | null {
  if (directClient !== undefined) return directClient;
  const apiKey = process.env.OPENAI_API_KEY;
  directClient = apiKey ? new OpenAI({ apiKey }) : null;
  return directClient;
}