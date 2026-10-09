/** A dispatched Server-Sent Events message. */
export interface SseMessage {
  /** The `event:` field, `message` when absent. */
  event: string;
  /** `data:` lines joined with `\n`. */
  data: string;
  /** The last `id:` seen on the stream (SSE semantics: it persists across messages). */
  id?: string;
}

/**
 * Incremental parser for the `text/event-stream` format (WHATWG HTML,
 * "Server-sent events", parsing an event stream). Feed it decoded text in
 * arbitrary chunks; it calls `onMessage` for every complete event.
 */
export class SseParser {
  private buffer = "";
  private event = "";
  private data: string[] = [];
  private lastId: string | undefined;
  private sawCarriageReturn = false;
  private readonly onMessage: (message: SseMessage) => void;

  constructor(onMessage: (message: SseMessage) => void) {
    this.onMessage = onMessage;
  }

  feed(chunk: string): void {
    // A CRLF split across chunks must not produce an extra empty line.
    if (this.sawCarriageReturn && chunk.startsWith("\n")) chunk = chunk.slice(1);
    this.sawCarriageReturn = chunk.endsWith("\r");
    this.buffer += chunk;
    const lines = this.buffer.split(/\r\n|\r|\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) this.line(line);
  }

  /** Flushes a final line without a terminator. A pending event without a blank line is discarded, per spec. */
  end(): void {
    if (this.buffer) this.line(this.buffer);
    this.buffer = "";
    this.event = "";
    this.data = [];
  }

  private line(line: string): void {
    if (line === "") {
      this.dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        this.event = value;
        break;
      case "data":
        this.data.push(value);
        break;
      case "id":
        if (!value.includes("\0")) this.lastId = value;
        break;
      default:
        // `retry` and unknown fields are ignored.
        break;
    }
  }

  private dispatch(): void {
    if (this.data.length === 0) {
      this.event = "";
      return;
    }
    const message: SseMessage = { event: this.event || "message", data: this.data.join("\n") };
    if (this.lastId !== undefined) message.id = this.lastId;
    this.event = "";
    this.data = [];
    this.onMessage(message);
  }
}

/** Reads a fetch response body to the end (or until `signal` aborts), feeding every chunk to an SseParser. */
export async function readSseStream(
  body: AsyncIterable<Uint8Array>,
  onMessage: (message: SseMessage) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  const parser = new SseParser(onMessage);
  for await (const chunk of body) parser.feed(decoder.decode(chunk, { stream: true }));
  parser.feed(decoder.decode());
  parser.end();
}
