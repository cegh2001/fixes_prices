import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';

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
    rounded_9_decimals: { type: Type.NUMBER,  description: 'Número redondeado a 9 decimales' },
    rounded_8_decimals: { type: Type.NUMBER,  description: 'Resultado anterior redondeado a 8 decimales' },
    rounded_7_decimals: { type: Type.NUMBER,  description: 'Resultado anterior redondeado a 7 decimales' },
    rounded_6_decimals: { type: Type.NUMBER,  description: 'Resultado anterior redondeado a 6 decimales' },
    rounded_5_decimals: { type: Type.NUMBER,  description: 'Resultado anterior redondeado a 5 decimales' },
    rounded_4_decimals: { type: Type.NUMBER,  description: 'Resultado anterior redondeado a 4 decimales' },
    rounded_3_decimals: { type: Type.NUMBER,  description: 'Resultado anterior redondeado a 3 decimales' },
    rounded_2_decimals: { type: Type.NUMBER,  description: 'Resultado anterior redondeado a 2 decimales' },
    rounded_1_decimal:  { type: Type.NUMBER,  description: 'Resultado anterior redondeado a 1 decimal' },
    rounded_integer:    { type: Type.INTEGER, description: 'Resultado anterior redondeado al entero más cercano' },
  },
  required: [
    'original',
    'rounded_9_decimals',
    'rounded_8_decimals',
    'rounded_7_decimals',
    'rounded_6_decimals',
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
2. rounded_9_decimals = redondear original a 9 decimales
3. rounded_8_decimals = redondear rounded_9_decimals a 8 decimales
4. rounded_7_decimals = redondear rounded_8_decimals a 7 decimales
5. rounded_6_decimals = redondear rounded_7_decimals a 6 decimales
6. rounded_5_decimals = redondear rounded_6_decimals a 5 decimales
7. rounded_4_decimals = redondear rounded_5_decimals a 4 decimales
8. rounded_3_decimals = redondear rounded_4_decimals a 3 decimales
9. rounded_2_decimals = redondear rounded_3_decimals a 2 decimales
10. rounded_1_decimal  = redondear rounded_2_decimals a 1 decimal
11. rounded_integer    = redondear rounded_1_decimal al entero más cercano

Ejemplo verificado:
- original: 345.444714567
- rounded_9_decimals: 345.444714567
- rounded_8_decimals: 345.44471457 (7 >= 5, sube)
- rounded_7_decimals: 345.4447146 (7 >= 5, sube)
- rounded_6_decimals: 345.444715 (6 >= 5, sube)
- rounded_5_decimals: 345.44472 (5 >= 5, sube)
- rounded_4_decimals: 345.4447 (2 < 5, baja)
- rounded_3_decimals: 345.445 (7 >= 5, sube)
- rounded_2_decimals: 345.45 (5 >= 5, sube)
- rounded_1_decimal: 345.5 (5 >= 5, sube)
- rounded_integer: 346 (5 >= 5, sube)

Devuelve SOLO el JSON con los resultados numéricos.`;
}

// Schema para modo decimal (cascade 9 → decimal especificado)
const decimalRoundingSchema = {
  type: Type.OBJECT,
  properties: {
    original:        { type: Type.NUMBER,  description: 'El número original recibido' },
    rounded:         { type: Type.NUMBER,  description: 'Resultado del redondeo en cascada hasta el decimal especificado' },
    rounded_integer: { type: Type.INTEGER, description: 'rounded redondeado al entero más cercano' },
  },
  required: ['original', 'rounded', 'rounded_integer'],
};

/**
 * Calcula full_rounded: partiendo de `rounded`, continúa la cascada nivel a nivel
 * (decimal-1 → decimal-2 → ... → entero) y devuelve el primer paso que redondea
 * hacia ARRIBA. Si todos los pasos bajan, retorna el entero.
 */
function computeFullRounded(rounded: number, decimalPlaces: number): number {
  let current = rounded;
  for (let d = decimalPlaces - 1; d >= 0; d--) {
    const next = d === 0
      ? Math.round(current)
      : parseFloat(current.toFixed(d));
    if (next > current) {
      // Este nivel redondea hacia arriba → es el full_rounded
      return next;
    }
    // Redondea hacia abajo → continuar al siguiente nivel
    current = next;
  }
  // Fallback: el entero (cuando todos los niveles bajan)
  return Math.round(current);
}

// Prompt para modo decimal
function buildDecimalPrompt(value: string, decimal: number): string {
  const lines: string[] = [`1. original = ${value}`];
  let prev = 'original';
  let step = 2;
  for (let d = 9; d >= decimal; d--) {
    lines.push(`${step}. temp_${d} = redondear ${prev} a ${d} decimales`);
    prev = `temp_${d}`;
    step++;
  }
  lines.push(`${step}. rounded = ${prev}  ← resultado final a ${decimal} decimales`);
  lines.push(`${step + 1}. rounded_integer = redondear rounded al entero más cercano`);

  return `Eres una calculadora de precisión. Dado el número ${value}, realiza el redondeo EN CASCADA de 9 decimales hasta ${decimal} decimal${decimal === 1 ? '' : 'es'}.

REGLAS:
- Redondeo estándar: si el dígito siguiente es >= 5, se redondea hacia ARRIBA; si < 5, hacia ABAJO.
- Cada paso usa el RESULTADO del paso anterior, NO el número original.

PASOS:
${lines.join('\n')}

Devuelve SOLO el JSON con los campos: original, rounded, rounded_integer.`;
}

// ── Interfaces ─────────────────────────────────────────────────
interface RoundingResult {
  original: number;
  rounded_9_decimals: number;
  rounded_8_decimals: number;
  rounded_7_decimals: number;
  rounded_6_decimals: number;
  rounded_5_decimals: number;
  rounded_4_decimals: number;
  rounded_3_decimals: number;
  rounded_2_decimals: number;
  rounded_1_decimal: number;
  rounded_integer: number;
}

interface DecimalRoundingResult {
  original: number;
  rounded: number;
  rounded_integer: number;
}

interface RoundingStringResponse {
  original: string;
  rounded_9_decimals: string;
  rounded_8_decimals: string;
  rounded_7_decimals: string;
  rounded_6_decimals: string;
  rounded_5_decimals: string;
  rounded_4_decimals: string;
  rounded_3_decimals: string;
  rounded_2_decimals: string;
  rounded_1_decimal: string;
  rounded_integer: string;
}

interface DecimalRoundingStringResponse {
  original: string;
  rounded: string;
  full_rounded: string;
  rounded_integer: string;
}

function toCompleteStringResponse(result: RoundingResult): RoundingStringResponse {
  return {
    original: result.original.toString(),
    rounded_9_decimals: result.rounded_9_decimals.toFixed(9),
    rounded_8_decimals: result.rounded_8_decimals.toFixed(8),
    rounded_7_decimals: result.rounded_7_decimals.toFixed(7),
    rounded_6_decimals: result.rounded_6_decimals.toFixed(6),
    rounded_5_decimals: result.rounded_5_decimals.toFixed(5),
    rounded_4_decimals: result.rounded_4_decimals.toFixed(4),
    rounded_3_decimals: result.rounded_3_decimals.toFixed(3),
    rounded_2_decimals: result.rounded_2_decimals.toFixed(2),
    // Requisito de negocio: siempre representar este paso con 2 decimales.
    rounded_1_decimal: result.rounded_1_decimal.toFixed(2),
    rounded_integer: result.rounded_integer.toString(),
  };
}

function toDecimalStringResponse(
  originalInput: string,
  result: DecimalRoundingResult,
  fullRoundedValue: number,
  decimalPlaces: number,
): DecimalRoundingStringResponse {
  return {
    original: originalInput,
    rounded: result.rounded.toFixed(decimalPlaces),
    full_rounded: fullRoundedValue.toFixed(decimalPlaces),
    rounded_integer: result.rounded_integer.toString(),
  };
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
  let body: { value?: unknown; decimal?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body JSON inválido' }, 400);
  }

  const { value, decimal } = body;
  if (value === undefined || value === null) {
    return c.json({ error: 'Se requiere el campo "value" (number o string)' }, 400);
  }

  const numStr = String(value).trim();
  if (numStr === '' || isNaN(Number(numStr))) {
    return c.json({ error: `"${value}" no es un número válido` }, 400);
  }

  // ─ Validar decimal (opcional) ─
  let decimalPlaces: number | undefined;
  if (decimal !== undefined && decimal !== null) {
    const d = Number(decimal);
    if (!Number.isInteger(d) || d < 1 || d > 9) {
      return c.json({ error: '"decimal" debe ser un entero entre 1 y 9' }, 400);
    }
    decimalPlaces = d;
  }

  // ─ Llamar a Gemini con structured output ─
  try {
    if (decimalPlaces !== undefined) {
      // Modo decimal: cascade de 9 hasta decimalPlaces
      const response = await ai.models.generateContent({
        model: MODEL,
        contents: buildDecimalPrompt(numStr, decimalPlaces),
        config: {
          responseMimeType: 'application/json',
          responseSchema: decimalRoundingSchema,
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.LOW,
          },
        },
      });

      const text = response.text;
      if (!text) {
        return c.json({ error: 'Respuesta vacía de Gemini' }, 502);
      }

      const result: DecimalRoundingResult = JSON.parse(text);
      const fullRoundedValue = computeFullRounded(result.rounded, decimalPlaces);
      return c.json(toDecimalStringResponse(numStr, result, fullRoundedValue, decimalPlaces));
    }

    // Modo completo (comportamiento original)
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: buildPrompt(numStr),
      config: {
        responseMimeType: 'application/json',
        responseSchema: roundingSchema,
        thinkingConfig: {
          thinkingLevel: ThinkingLevel.LOW,
        },
      },
    });

    const text = response.text;
    if (!text) {
      return c.json({ error: 'Respuesta vacía de Gemini' }, 502);
    }

    const result: RoundingResult = JSON.parse(text);
    return c.json(toCompleteStringResponse(result));
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
