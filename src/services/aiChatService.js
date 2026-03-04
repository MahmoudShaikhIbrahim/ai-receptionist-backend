const OpenAI = require("openai");

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

async function getAIResponse(messages) {
  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.6,
    messages
  });

  return response.choices[0].message.content;
}

module.exports = { getAIResponse };