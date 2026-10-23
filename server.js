import 'dotenv/config';
import express from 'express';
import OpenAI from 'openai';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

app.disable('x-powered-by');
app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    aiConfigured: Boolean(process.env.OPENAI_API_KEY),
    model: MODEL
  });
});

const foodSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    confidence: {
      type: 'string',
      enum: ['alta', 'media', 'baja']
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          portion_grams: { type: 'integer' },
          calories_kcal: { type: 'integer' },
          protein_g: { type: 'number' },
          carbs_g: { type: 'number' },
          fat_g: { type: 'number' },
          confidence: {
            type: 'string',
            enum: ['alta', 'media', 'baja']
          },
          basis: { type: 'string' }
        },
        required: [
          'name',
          'portion_grams',
          'calories_kcal',
          'protein_g',
          'carbs_g',
          'fat_g',
          'confidence',
          'basis'
        ]
      }
    },
    tips: {
      type: 'array',
      items: { type: 'string' }
    }
  },
  required: ['summary', 'confidence', 'items', 'tips']
};

app.post('/api/analyze', async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({
        error: 'Falta configurar OPENAI_API_KEY en el archivo .env.'
      });
    }

    const { image, context = '' } = req.body ?? {};

    if (
      typeof image !== 'string' ||
      !/^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(image)
    ) {
      return res.status(400).json({
        error: 'La imagen no tiene un formato válido. Sube una imagen JPG, PNG o WEBP.'
      });
    }

    if (image.length > 10_500_000) {
      return res.status(413).json({
        error: 'La imagen es demasiado grande. Prueba con una fotografía más pequeña.'
      });
    }

    const safeContext =
      typeof context === 'string' ? context.slice(0, 240) : '';

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    const response = await openai.responses.create({
      model: MODEL,
      store: false,
      input: [
        {
          role: 'system',
          content:
            'Eres un asistente de estimación nutricional que analiza fotografías de alimentos. Responde en español. Identifica los alimentos visibles y estima sus porciones en gramos, calorías, proteínas, carbohidratos y grasas. Los valores deben ser razonables y basarse en porciones habituales. Una fotografía no permite conocer con exactitud el peso, los ingredientes ocultos, el aceite utilizado ni la receta. Comunica claramente la incertidumbre y nunca presentes los valores como exactos. Si el usuario proporciona detalles adicionales, incorpóralos. No hagas diagnósticos médicos ni prescribas dietas. Si no hay comida identificable, devuelve un arreglo items vacío y explica el motivo en summary. Los números deben ser no negativos. Incluye de uno a tres consejos prácticos y neutrales.'
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text:
                `Analiza esta fotografía y estima su información nutricional. ` +
                `Detalles adicionales del usuario: ${safeContext || 'No proporcionó detalles.'}`
            },
            {
              type: 'input_image',
              image_url: image,
              detail: 'high'
            }
          ]
        }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'food_nutrition_estimate',
          strict: true,
          schema: foodSchema
        }
      }
    });

    if (!response.output_text) {
      return res.status(502).json({
        error: 'La IA no devolvió un análisis válido. Intenta con otra fotografía.'
      });
    }

    const result = JSON.parse(response.output_text);

    const items = (
      Array.isArray(result.items) ? result.items : []
    ).map(item => ({
      name: String(item.name || 'Alimento desconocido').slice(0, 120),
      portion_grams: nonNegativeNumber(item.portion_grams),
      calories_kcal: nonNegativeNumber(item.calories_kcal),
      protein_g: round1(nonNegativeNumber(item.protein_g)),
      carbs_g: round1(nonNegativeNumber(item.carbs_g)),
      fat_g: round1(nonNegativeNumber(item.fat_g)),
      confidence: ['alta', 'media', 'baja'].includes(item.confidence)
        ? item.confidence
        : 'media',
      basis: String(item.basis || '').slice(0, 200)
    }));

    const sum = key =>
      round1(items.reduce((total, item) => total + item[key], 0));

    return res.json({
      summary: String(
        result.summary || 'Estimación nutricional aproximada.'
      ).slice(0, 500),

      confidence: ['alta', 'media', 'baja'].includes(result.confidence)
        ? result.confidence
        : 'media',

      items,

      total_calories_kcal: Math.round(sum('calories_kcal')),
      total_protein_g: sum('protein_g'),
      total_carbs_g: sum('carbs_g'),
      total_fat_g: sum('fat_g'),

      tips: (
        Array.isArray(result.tips) ? result.tips : []
      ).slice(0, 4).map(tip => String(tip).slice(0, 220))
    });

  } catch (error) {
    console.error(
      'Error en /api/analyze:',
      error?.status || error?.message || 'Error desconocido'
    );

    if (error?.status === 401) {
      return res.status(503).json({
        error: 'La clave de API no es válida. Revisa OPENAI_API_KEY en tu archivo .env.'
      });
    }

    if (error?.status === 429) {
      return res.status(429).json({
        error: 'Se alcanzó un límite de uso de la API. Revisa tu facturación y los límites de uso.'
      });
    }

    return res.status(502).json({
      error: 'No se pudo completar el análisis. Verifica tu conexión, la configuración del modelo y tu acceso a la API.'
    });
  }
});

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    return next();
  }

  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`NutriSnap listo en http://localhost:${PORT}`);
  console.log(`Modelo configurado: ${MODEL}`);
});
