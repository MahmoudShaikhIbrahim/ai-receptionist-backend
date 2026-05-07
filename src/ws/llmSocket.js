// src/ws/llmSocket.js

const { processLLMMessage } = require("../controllers/llmSocketController");
const Agent = require("../models/Agent");
const Call  = require("../models/Call");

function extractLatestUserText(data) {
  const transcript = Array.isArray(data?.transcript)
    ? data.transcript
    : Array.isArray(data?.transcript_json)
    ? data.transcript_json
    : [];

  for (let i = transcript.length - 1; i >= 0; i--) {
    const item = transcript[i];
    if (!item || typeof item !== "object") continue;

    const text =
      typeof item.content === "string" ? item.content.trim()
      : typeof item.text === "string"  ? item.text.trim()
      : "";

    if (!text) continue;

    const role    = (item.role    || "").toLowerCase();
    const speaker = (item.speaker || "").toLowerCase();

    if (
      role === "user" || role === "caller" || role === "customer" ||
      speaker === "user" || speaker === "caller" || speaker === "customer"
    ) {
      return text;
    }

    if (i === transcript.length - 1 && role !== "agent" && role !== "assistant") {
      return text;
    }
  }
  return "";
}

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function handleLLMWebSocket(ws, req) {
  console.log("🔌 Retell WebSocket connected");
  const callStartTime = Date.now();

  // Track processed response_ids to avoid duplicates
  const processedResponseIds = new Set();
  // Track in-flight response_ids to avoid processing same id twice concurrently
  const inFlightResponseIds  = new Set();
  // Last sent response per call — used to re-send if Retell asks again
  let lastResponseText = null;
  let lastResponseId   = null;
  // Dedup by user text — if same text is sent twice quickly, only process once
  let lastProcessedText = null;
  let lastProcessedTextTime = 0;
  // Per-call mutex — only ONE request processes at a time
  // Queue of pending requests waiting for the mutex
  let mutexLocked = false;
  const pendingQueue = [];
  
  function acquireCallMutex() {
    return new Promise(resolve => {
      if (!mutexLocked) {
        mutexLocked = true;
        resolve();
      } else {
        pendingQueue.push(resolve);
      }
    });
  }
  
  function releaseCallMutex() {
    if (pendingQueue.length > 0) {
      const next = pendingQueue.shift();
      next();
    } else {
      mutexLocked = false;
    }
  }

  // Send initial greeting dynamically from agent settings
  // Extract callId from URL path e.g. /llm/respond/call_xxx
  // Extract callId from WebSocket URL — retry lookup to handle race condition
  // where WebSocket connects before the Retell webhook saves the Call document
  const urlParts = (req?.url || "").split("/");
  const callIdFromUrl = urlParts[urlParts.length - 1]?.startsWith("call_")
    ? urlParts[urlParts.length - 1] : null;

  (async () => {
    let agent = null;
    if (callIdFromUrl) {
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          const callDoc = await Call.findOne({
            $or: [{ callId: callIdFromUrl }, { call_id: callIdFromUrl }]
          }).lean();
          if (callDoc?.agentId) {
            agent = await Agent.findById(callDoc.agentId).lean();
            if (agent) break;
          }
        } catch (e) {
          console.error("Greeting attempt", attempt + 1, "error:", e.message);
        }
        await new Promise(r => setTimeout(r, 500));
      }
    }
    if (agent) {
      const isArabic = (agent.language || "English").toLowerCase().includes("arab");
      const greeting = isArabic
        ? `أهلاً وسهلاً في ${agent.businessName}! شو بقدر أساعدك؟`
        : `Welcome to ${agent.businessName}! How can I help you?`;
      safeSend(ws, { response_id: 0, content: greeting, content_complete: true, end_call: false });
      processedResponseIds.add(0);
      console.log(`📤 Greeting (${isArabic ? "ar" : "en"}): ${greeting}`);
    } else {
      safeSend(ws, { response_id: 0, content: "Welcome! How can I help you?", content_complete: true, end_call: false });
      processedResponseIds.add(0);
      console.log("📤 Greeting fallback — agent not found for", callIdFromUrl);
    }
  })();

  ws.on("message", async (rawMessage) => {
    let data;
    try {
      data = JSON.parse(rawMessage.toString());
    } catch {
      safeSend(ws, {
        response_id: 0,
        content: "Sorry, could you repeat that?",
        content_complete: true,
        end_call: false,
      });
      return;
    }

    try {
      const interactionType = data?.interaction_type;
      const responseId      = data?.response_id ?? 0;

      if (interactionType !== "response_required") return;

      // Already processed this response_id — re-send last response if available
      if (processedResponseIds.has(responseId)) {
        console.log(`⏭ Already processed response_id: ${responseId}`);
        if (lastResponseText && lastResponseId === responseId) {
          safeSend(ws, {
            response_id: responseId,
            content: lastResponseText,
            content_complete: true,
            end_call: false,
          });
        }
        return;
      }

      // Currently processing this response_id — wait and re-send when done
      if (inFlightResponseIds.has(responseId)) {
        console.log(`⏳ In-flight response_id: ${responseId} — waiting`);
        // Wait up to 8 seconds for the in-flight request to finish
        for (let i = 0; i < 16; i++) {
          await new Promise(r => setTimeout(r, 500));
          if (!inFlightResponseIds.has(responseId)) {
            // It finished — re-send the response
            if (lastResponseText) {
              safeSend(ws, {
                response_id: responseId,
                content: lastResponseText,
                content_complete: true,
                end_call: false,
              });
            }
            return;
          }
        }
        console.log(`⚠️ In-flight timeout for response_id: ${responseId}`);
        return;
      }

      // Extract user text early — needed for echo guard
      const latestUserText = extractLatestUserText(data);

      // Skip early responses that are echoes of our own greeting.
      // The transcriber picks up the agent's Arabic greeting and sends it back
      // as garbled English. Block non-Arabic text for first 6 seconds.
      const callAge = Date.now() - callStartTime;
      const textHasArabic = /[\u0600-\u06FF]/.test(latestUserText);

      if (callAge < 6000 && !textHasArabic) {
        console.log(`⏭ Blocking echo response_id ${responseId} (${callAge}ms, no Arabic chars)`);
        processedResponseIds.add(responseId);
        safeSend(ws, {
          response_id: responseId,
          content: "",
          content_complete: true,
          end_call: false,
        });
        return;
      }

      // DEDUP STRATEGY:
      // Retell sends partials as transcription builds: "بدي" -> "بدي 2" -> "بدي 2 زنجر ساندويش"
      // We want to process ONLY the final longest version.
      const now = Date.now();

      // Skip exact duplicates
      if (latestUserText && latestUserText === lastProcessedText && now - lastProcessedTextTime < 5000) {
        console.log(`Exact duplicate: "${latestUserText.slice(0,40)}"`);
        processedResponseIds.add(responseId);
        return;
      }

      // Skip ONLY if this text is a true prefix of what was already processed
      // i.e. lastProcessedText STARTS WITH this text (it's an older partial build-up)
      // Do NOT skip if it's a completely different sentence
      const isOlderPartial = latestUserText && lastProcessedText &&
          lastProcessedText.length > latestUserText.length + 3 &&
          lastProcessedText.startsWith(latestUserText.trim()) &&
          now - lastProcessedTextTime < 3000;
      if (isOlderPartial) {
        console.log(`Older partial (prefix): "${latestUserText.slice(0,30)}"`);
        processedResponseIds.add(responseId);
        return;
      }

      // Wait for transcript to stabilize
      const looksIncomplete = !latestUserText || latestUserText.trim().length < 10 ||
        /(بدي|و|آه|اه|أنا|في|من|على|كمان)$/.test(latestUserText.trim());
      await new Promise(r => setTimeout(r, looksIncomplete ? 700 : 350));

      // After wait - if already processed skip
      if (processedResponseIds.has(responseId)) return;

      // Update tracking
      if (latestUserText) {
        lastProcessedText = latestUserText;
        lastProcessedTextTime = now;
      }

      // Acquire mutex
      await acquireCallMutex();

      // Final stale check after mutex — only skip true prefixes
      const staleAfterMutex = latestUserText && lastProcessedText &&
          lastProcessedText.length > latestUserText.length + 5 &&
          lastProcessedText.startsWith(latestUserText.trim()) &&
          now - lastProcessedTextTime < 2000;
      if (staleAfterMutex) {
        console.log(`Stale after mutex: "${latestUserText.slice(0,30)}"`);
        processedResponseIds.add(responseId);
        releaseCallMutex();
        return;
      }

            // Mark as in-flight
      inFlightResponseIds.add(responseId);
      console.log("🗣 User:", latestUserText || "(none)");

      const result = await processLLMMessage(
        { ...data, latest_user_text: latestUserText },
        req
      );

      // Mark as done and release mutex
      inFlightResponseIds.delete(responseId);
      processedResponseIds.add(responseId);
      releaseCallMutex();

      if (!result?.response) return;

      const responseText  = result.response.trim();
      const shouldEndCall = result?.end_call === true;

      // Save last response for potential re-sends
      lastResponseText = responseText;
      lastResponseId   = responseId;

      console.log("📤 Response:", responseText);

      safeSend(ws, {
        response_id: responseId,
        content: responseText,
        content_complete: true,
        end_call: shouldEndCall,
      });

    } catch (err) {
      console.error("❌ Error:", err.message || err);
      const responseId = data?.response_id ?? 0;
      inFlightResponseIds.delete(responseId);
      releaseCallMutex();
      safeSend(ws, {
        response_id: responseId,
        content: "Sorry, something went wrong. Could you repeat that?",
        content_complete: true,
        end_call: false,
      });
    }
  });

  ws.on("close", (code) => console.log("🔌 WebSocket closed, code:", code));
  ws.on("error", (err)  => console.error("WebSocket error:", err.message));
}

module.exports = { handleLLMWebSocket };