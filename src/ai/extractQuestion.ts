import OpenAI from 'openai';

let client: OpenAI | null = null;

function getClient(): OpenAI | null {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  if (!client) client = new OpenAI({ apiKey: key });
  return client;
}

/**
 * Uses GPT-4o-mini to extract the actual question or message from noisy
 * PTY terminal output. Falls back to the provided fallback string if OpenAI
 * is unavailable or the call fails.
 */
export async function extractQuestion(
  rawText: string,
  fallback: string,
): Promise<string> {
  const ai = getClient();
  if (!ai || !rawText.trim()) return fallback;

  try {
    const response = await ai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 60,
      messages: [
        {
          role: 'system',
          content:
            'Extract the question or message the AI coding agent is asking the user from the terminal output. ' +
            'Return ONLY the question or message text — no explanation, no quotes, no punctuation changes. ' +
            'Max 150 characters. If no clear question is found, return an empty string.',
        },
        {
          role: 'user',
          content: rawText.slice(0, 1000),
        },
      ],
    });

    const text = response.choices[0]?.message?.content?.trim() ?? '';
    return text.length > 0 ? text : fallback;
  } catch {
    return fallback;
  }
}
