const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

async function getAIResponse(messages) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: messages,
    temperature: 0.4,
    max_tokens: 120
  });

  return completion.choices[0].message.content;
}

module.exports = { getAIResponse };