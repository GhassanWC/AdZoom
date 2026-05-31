/**
 * Public chatbot endpoint. Anonymous (no Firebase token), rate-limited
 * by client IP, streams Gemini output back as Server-Sent Events.
 *
 * Request:  POST { messages: [{ role: "user" | "assistant", content: string }] }
 * Response: text/event-stream — each chunk is `data: <text>\n\n`,
 *           plus a final `data: [DONE]\n\n` sentinel.
 *
 * The chat history is sent in full on every turn; the server doesn't
 * keep state. The client owns persistence (localStorage). Max 30
 * messages per conversation, each ≤ 2000 chars.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getGemini, ANALYSIS_MODEL } from "@/lib/gemini";
import { ADZOOM_SYSTEM_PROMPT } from "@/lib/chat/system-prompt";
import { checkRateLimit, clientIp } from "@/lib/chat/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatRequest {
  messages: ChatMessage[];
}

const MAX_MESSAGES = 30;
const MAX_CONTENT_CHARS = 2000;

export async function POST(req: NextRequest) {
  // 1. Validate body shape early so malformed clients fail fast.
  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return NextResponse.json(
      { error: "Body must include `messages: [{role, content}, …]`." },
      { status: 400 }
    );
  }
  if (body.messages.length > MAX_MESSAGES) {
    return NextResponse.json(
      { error: `Conversation too long (max ${MAX_MESSAGES} messages).` },
      { status: 400 }
    );
  }
  for (const m of body.messages) {
    if (
      (m.role !== "user" && m.role !== "assistant") ||
      typeof m.content !== "string"
    ) {
      return NextResponse.json(
        { error: "Each message needs role ∈ {user, assistant} and string content." },
        { status: 400 }
      );
    }
    if (m.content.length > MAX_CONTENT_CHARS) {
      return NextResponse.json(
        { error: `Message too long (max ${MAX_CONTENT_CHARS} chars).` },
        { status: 400 }
      );
    }
  }
  // Last message must be a user turn — anything else means the client
  // wandered into a weird state.
  if (body.messages[body.messages.length - 1].role !== "user") {
    return NextResponse.json(
      { error: "Last message must come from the user." },
      { status: 400 }
    );
  }

  // 2. IP rate limit.
  const ip = clientIp(req.headers);
  const rl = checkRateLimit(ip);
  if (!rl.ok) {
    return NextResponse.json(
      {
        error: "You're sending messages too quickly. Try again in a few minutes.",
        retryInSeconds: rl.retryInSeconds,
      },
      { status: 429 }
    );
  }

  // 3. Configure check — bail BEFORE opening the stream so the client
  // sees a clean JSON error rather than a half-empty SSE stream.
  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json(
      { error: "AdZoom's assistant is offline right now — email hello@adzoom.app." },
      { status: 503 }
    );
  }

  // 4. Translate to the Gemini SDK's `contents` shape. The SDK uses
  // "user" and "model" as the two role names, not "user" / "assistant".
  const contents = body.messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  // 5. Open the SSE stream. We use a `TransformStream` so we can push
  // text chunks from the async iterable into the response body.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => {
        // SSE framing: `data: <payload>\n\n`. We split on newlines so
        // each line gets its own `data:` prefix per the spec.
        const lines = text.split("\n").map((l) => `data: ${l}`).join("\n");
        controller.enqueue(encoder.encode(`${lines}\n\n`));
      };

      try {
        const ai = getGemini();
        const result = await ai.models.generateContentStream({
          model: ANALYSIS_MODEL,
          contents,
          config: {
            systemInstruction: ADZOOM_SYSTEM_PROMPT,
            temperature: 0.4,
            maxOutputTokens: 400,
          },
        });

        for await (const chunk of result) {
          const text = chunk.text;
          if (text) send(text);
        }
      } catch (err) {
        console.error("[chat] gemini stream error", err);
        send(
          "Sorry — AdZoom's assistant hit an error. Try again in a moment, or email hello@adzoom.app."
        );
      } finally {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // disable buffering on Nginx-style proxies
    },
  });
}
