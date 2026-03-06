const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

async function getAIResponse(messages) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: messages,
      temperature: 0.4,
      max_tokens: 120
    });

    return completion.choices?.[0]?.message?.content || "";
  } catch (error) {
    console.error("OpenAI error:", error.message);
    return "";
  }
}
module.exports = { getAIResponse };