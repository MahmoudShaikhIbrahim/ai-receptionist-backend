const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

async function getAIResponse(message) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: "You are a friendly restaurant receptionist helping customers make reservations."
      },
      {
        role: "user",
        content: message
      }
    ]
  });

  return completion.choices[0].message.content;
}

module.exports = { getAIResponse };