import { SYSTEM_PROMPT } from './db';

const OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL;
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;

export async function callOpenClaw(userPrompt: string, context = '') {
  if (!OPENCLAW_GATEWAY_URL || !OPENCLAW_GATEWAY_TOKEN) {
    console.log('[MOCK] Would call OpenClaw');
    return { success: true, response: '**VERDICT: PASS**\n\n[Mock mode] Code looks good!' };
  }

  const userMessage = `${userPrompt}\n\n## Pull Request Details\n${context}`;

  try {
    const response = await fetch(`${OPENCLAW_GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        model: 'default',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
      }),
    });
    
    if (!response.ok) {
      return { success: false, error: await response.text() };
    }
    
    const data = await response.json();
    return { success: true, response: data.choices?.[0]?.message?.content || 'No response' };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}
