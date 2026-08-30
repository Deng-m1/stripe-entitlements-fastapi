import { describe, expect, it } from "vitest";

import {
  BodyReadError,
  BodyTooLargeError,
  readBoundedRequestBody,
} from "../../src/bounded-body.js";

function streamedRequest(stream: ReadableStream<Uint8Array>): Request {
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    body: stream,
    duplex: "half",
  };
  return new Request("https://billing.example/internal", init);
}

describe("bounded request body reader", () => {
  it("preserves exact bytes across chunks at the configured boundary", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2]));
        controller.enqueue(Uint8Array.from([3, 4, 5]));
        controller.close();
      },
    });

    await expect(
      readBoundedRequestBody(streamedRequest(stream), 5),
    ).resolves.toEqual(Uint8Array.from([1, 2, 3, 4, 5]));
  });

  it("cancels the stream as soon as cumulative bytes exceed the bound", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4));
        controller.enqueue(new Uint8Array(2));
      },
      cancel() {
        canceled = true;
      },
    });

    await expect(
      readBoundedRequestBody(streamedRequest(stream), 5),
    ).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(canceled).toBe(true);
  });

  it("uses a stable error for failed or previously consumed streams", async () => {
    const failed = streamedRequest(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("private transport detail"));
        },
      }),
    );
    await expect(readBoundedRequestBody(failed, 10)).rejects.toBeInstanceOf(
      BodyReadError,
    );

    const consumed = new Request("https://billing.example/internal", {
      method: "POST",
      body: "{}",
    });
    await consumed.text();
    await expect(readBoundedRequestBody(consumed, 10)).rejects.toBeInstanceOf(
      BodyReadError,
    );
  });
});
