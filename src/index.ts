import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { GoogleGenAI, Type } from '@google/genai';

const app = new Hono();
app.use('*', cors());

// ── Gemini client ──────────────────────────────────────────────
const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY! });
const MODEL = 'gemini-3.1-flash-lite-preview';

// ── Structured Output Schema ───────────────────────────────────
// Cada propiedad representa un paso del redondeo en cascada.
// Gemini devuelve JSON que cumple exactamente este schema.
const roundingSchema = {
  type: Type.OBJECT,
  properties: {
    original:           { type: Type.NUMBER,  description: 'El número original recibido' },
    rounded_5_decimals: { type: Type.NUMBER,  description: 'Número redondeado a 5 decimales' },
    rounded_4_decimals: { type: Type.NUMBER,  description: 'Resultado anterior redondeado a 4 decimales' },
    rounded_3_decimals: { type: Type.NUMBER,  description: 'Resultado anterior redondeado a 3 decimales' },
    rounded_2_decimals: { type: Type.NUMBER,  description: 'Resultado anterior redondeado a 2 decimales' },
    rounded_1_decimal:  { type: Type.NUMBER,  description: 'Resultado anterior redondeado a 1 decimal' },
    rounded_integer:    { type: Type.INTEGER, description: 'Resultado anterior redondeado al entero más cercano' },
  },
  required: [
    'original',
    'rounded_5_decimals',
    'rounded_4_decimals',
    'rounded_3_decimals',
    'rounded_2_decimals',
    'rounded_1_decimal',
    'rounded_integer',
  ],
};

// ── Prompt builder ─────────────────────────────────────────────
function buildPrompt(value: string): string {
  return `Eres una calculadora de precisión. Dado el número ${value}, realiza el redondeo EN CASCADA paso a paso.

REGLAS:
- Redondeo estándar: si el dígito siguiente es >= 5, se redondea hacia ARRIBA; si < 5, hacia ABAJO.
- Cada paso usa el RESULTADO del paso anterior, NO el número original.

PASOS:
1. original = ${value}
2. rounded_5_decimals = redondear original a 5 decimales
3. rounded_4_decimals = redondear rounded_5_decimals a 4 decimales
4. rounded_3_decimals = redondear rounded_4_decimals a 3 decimales
5. rounded_2_decimals = redondear rounded_3_decimals a 2 decimales
6. rounded_1_decimal  = redondear rounded_2_decimals a 1 decimal
7. rounded_integer    = redondear rounded_1_decimal al entero más cercano

Ejemplo verificado:
- original: 345.44471
- rounded_5_decimals: 345.44471
- rounded_4_decimals: 345.4447 (1 < 5, baja)
- rounded_3_decimals: 345.445 (7 >= 5, sube)
- rounded_2_decimals: 345.45 (5 >= 5, sube)
- rounded_1_decimal: 345.5 (5 >= 5, sube)
- rounded_integer: 346 (5 >= 5, sube)

Devuelve SOLO el JSON con los resultados numéricos.`;
}

// ── Interfaces ─────────────────────────────────────────────────
interface RoundingResult {
  original: number;
  rounded_5_decimals: number;
  rounded_4_decimals: number;
  rounded_3_decimals: number;
  rounded_2_decimals: number;
  rounded_1_decimal: number;
  rounded_integer: number;
}

// ── Routes ─────────────────────────────────────────────────────

app.get('/', (c) =>
  c.json({
    service: 'fixes_prices',
    version: '1.0.0',
    description: 'Redondeo en cascada de decimales usando Gemini AI',
    endpoints: {
      'POST /round': 'Recibe { "value": number|string } y devuelve redondeo en cascada',
    },
  })
);

app.get('/health', (c) => c.json({ status: 'ok' }));

app.post('/round', async (c) => {
  // ─ Validar input ─
  let body: { value?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body JSON inválido' }, 400);
  }

  const { value } = body;
  if (value === undefined || value === null) {
    return c.json({ error: 'Se requiere el campo "value" (number o string)' }, 400);
  }

  const numStr = String(value).trim();
  if (numStr === '' || isNaN(Number(numStr))) {
    return c.json({ error: `"${value}" no es un número válido` }, 400);
  }

  // ─ Llamar a Gemini con structured output ─
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: buildPrompt(numStr),
      config: {
        responseMimeType: 'application/json',
        responseSchema: roundingSchema,
        thinkingConfig: {
          thinkingLevel: 'low',
        },
      },
    });

    const text = response.text;
    if (!text) {
      return c.json({ error: 'Respuesta vacía de Gemini' }, 502);
    }

    const result: RoundingResult = JSON.parse(text);
    return c.json(result);
  } catch (err) {
    console.error('[round] Error Gemini:', err);
    const message = err instanceof Error ? err.message : 'Error desconocido';
    return c.json({ error: 'Error al procesar redondeo', detail: message }, 502);
  }
});

// ── Server (Bun) ───────────────────────────────────────────────
const port = Number(process.env.PORT) || 3001;

export default {
  port,
  fetch: app.fetch,
};

console.log(`🔢 fixes_prices running on http://localhost:${port}`);
