
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function extractMedicineName(text: string): Promise<string | null> {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'Extract the medicine or drug name from the user message. ' +
            'Return only the medicine name in English, nothing else. ' +
            'If no medicine name is found, return the word null.',
        },
        { role: 'user', content: text },
      ],
      max_tokens: 50,
      temperature: 0,
    });
    const result = completion.choices[0]?.message?.content?.trim();
    return result && result.toLowerCase() !== 'null' ? result : null;
  } catch (err) {
    console.error('extractMedicineName error:', err instanceof Error ? err.message : err);
    return null;
  }
}
