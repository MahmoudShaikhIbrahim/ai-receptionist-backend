const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function getAIResponse(messages) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.4,
      max_tokens: 80,
    });

    return completion.choices?.[0]?.message?.content || "";
  } catch (error) {
    console.error("OpenAI error:", error.message);
    return "";
  }
}

/**
 * Streaming version — calls onChunk(text) as tokens arrive.
 * Returns the full response string when done.
 */
async function streamAIResponse(messages, onChunk) {
  try {
    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.4,
      max_tokens: 80,
      stream: true,
    });

    let fullText = "";
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content || "";
      if (delta) {
        fullText += delta;
        if (onChunk) onChunk(delta);
      }
    }
    return fullText;
  } catch (error) {
    console.error("OpenAI streaming error:", error.message);
    return "";
  }
}

module.exports = { getAIResponse, streamAIResponse };
