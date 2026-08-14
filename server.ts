import express from "express";
import path from "path";
import dotenv from "dotenv";
import { GoogleGenAI, Type } from "@google/genai";
import { createServer as createViteServer } from "vite";

dotenv.config();

const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json({ limit: "15mb" }));

// Helper to initialize Gemini client on-demand (lazy)
function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is missing.");
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

// Health endpoint
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
    timestamp: new Date().toISOString(),
  });
});

// Parse food text or voice transcript
app.post("/api/parse-food", async (req, res) => {
  try {
    const { transcript, mealType } = req.body;

    if (!transcript || typeof transcript !== "string" || !transcript.trim()) {
      return res.status(400).json({ error: "Transcript text is required." });
    }

    const ai = getGeminiClient();

    const prompt = `User logged food intake: "${transcript.trim()}". ${
      mealType ? `Selected meal category preference: ${mealType}.` : ""
    }
Identify all distinct food items, infer realistic quantities if unspecified, and calculate standard nutritional values (calories, protein in g, carbs in g, fat in g).
Special emphasis on Indian food accuracy (e.g., 1 roti = ~80-90 kcal, 1 bowl dal = ~150 kcal, 1 bowl rice = ~180-200 kcal, 1 paneer dish = ~250-300 kcal, 1 banana = ~105 kcal).`;

    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-lite",
      contents: prompt,
      config: {
        systemInstruction: `You are an expert nutritionist specializing in global and Indian cuisine (including regional foods like rotis, parathas, idlis, dosas, dals, paneer, biryani, poha, sabzi, samosas, etc.). 
Break down the food items described by the user into discrete, editable line items. Estimate accurate calories, protein (g), carbs (g), and fat (g) based on standard cooked serving sizes. 
Always return valid JSON matching the schema.`,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            mealTitle: {
              type: Type.STRING,
              description: "Short catchy title for this meal, e.g. 'Roti, Dal & Banana'",
            },
            suggestedMealType: {
              type: Type.STRING,
              description: "Meal category: breakfast, lunch, dinner, or snack",
            },
            items: {
              type: Type.ARRAY,
              description: "List of identified food items",
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING, description: "Food item name (e.g. 'Wheat Roti / Chapati')" },
                  quantity: { type: Type.NUMBER, description: "Quantity numeric value (e.g. 2)" },
                  unit: { type: Type.STRING, description: "Serving unit (e.g. 'pcs', 'bowl (150g)', 'medium', 'cup')" },
                  calories: { type: Type.NUMBER, description: "Total estimated calories for this item quantity" },
                  protein: { type: Type.NUMBER, description: "Total protein in grams" },
                  carbs: { type: Type.NUMBER, description: "Total carbs in grams" },
                  fat: { type: Type.NUMBER, description: "Total fat in grams" },
                  indianFoodNotes: { type: Type.STRING, description: "Brief helpful nutritional note or context" },
                },
                required: ["name", "quantity", "unit", "calories", "protein", "carbs", "fat"],
              },
            },
            totalCalories: { type: Type.NUMBER, description: "Sum of calories" },
            totalProtein: { type: Type.NUMBER, description: "Sum of protein in grams" },
            totalCarbs: { type: Type.NUMBER, description: "Sum of carbs in grams" },
            totalFat: { type: Type.NUMBER, description: "Sum of fat in grams" },
            healthTips: { type: Type.STRING, description: "One concise, encouraging health tip regarding this meal" },
          },
          required: ["mealTitle", "suggestedMealType", "items", "totalCalories", "totalProtein", "totalCarbs", "totalFat"],
        },
      },
    });

    const responseText = response.text || "{}";
    const parsedData = JSON.parse(responseText);

    return res.json({ success: true, data: parsedData });
  } catch (err: any) {
    console.error("Error parsing food:", err);
    return res.status(500).json({
      error: "Failed to estimate nutritional content.",
      message: err?.message || "Unknown error occurred.",
    });
  }
});

// Analyze food photo
app.post("/api/analyze-image", async (req, res) => {
  try {
    const { imageBase64, mimeType = "image/jpeg", textHint } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: "Image data is required." });
    }

    const ai = getGeminiClient();

    const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, "");

    const parts: any[] = [
      {
        inlineData: {
          mimeType,
          data: cleanBase64,
        },
      },
      {
        text: `Identify the food dishes in this photo and estimate their serving sizes, calories, and macros (protein, carbs, fat). ${
          textHint ? `User notes: "${textHint}".` : ""
        } Pay special attention to Indian regional dishes and standard home-cooked portion sizes.`,
      },
    ];

    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-lite",
      contents: { parts },
      config: {
        systemInstruction: `You are an expert food image recognition AI and nutritionist. Visually estimate the meal components and portion sizes in the provided photo.
Return JSON output with structured meal title, meal type, items with macros, total calories, total protein, carbs, fat, and a concise health tip.`,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            mealTitle: { type: Type.STRING },
            suggestedMealType: { type: Type.STRING },
            items: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  quantity: { type: Type.NUMBER },
                  unit: { type: Type.STRING },
                  calories: { type: Type.NUMBER },
                  protein: { type: Type.NUMBER },
                  carbs: { type: Type.NUMBER },
                  fat: { type: Type.NUMBER },
                  indianFoodNotes: { type: Type.STRING },
                },
                required: ["name", "quantity", "unit", "calories", "protein", "carbs", "fat"],
              },
            },
            totalCalories: { type: Type.NUMBER },
            totalProtein: { type: Type.NUMBER },
            totalCarbs: { type: Type.NUMBER },
            totalFat: { type: Type.NUMBER },
            healthTips: { type: Type.STRING },
          },
          required: ["mealTitle", "suggestedMealType", "items", "totalCalories", "totalProtein", "totalCarbs", "totalFat"],
        },
      },
    });

    const responseText = response.text || "{}";
    const parsedData = JSON.parse(responseText);

    return res.json({ success: true, data: parsedData });
  } catch (err: any) {
    console.error("Error analyzing image:", err);
    return res.status(500).json({
      error: "Failed to analyze food image.",
      message: err?.message || "Unknown error occurred.",
    });
  }
});

// Setup Vite Dev Middleware or Production static serving
async function start() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Lume server running on http://0.0.0.0:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
});
