import { EventEmitter } from "node:events";
import type { RuntimeEvent } from "../types.js";

export class EventBus {
  private readonly emitter = new EventEmitter();

  publish(event: RuntimeEvent): void {
    this.emitter.emit("*", event);
    this.emitter.emit(event.type, event);
  }

  subscribe(handler: (event: RuntimeEvent) => void): () => void {
    this.emitter.on("*", handler);
    return () => this.emitter.off("*", handler);
  }

  on<T extends RuntimeEvent["type"]>(
    type: T,
    handler: (event: Extract<RuntimeEvent, { type: T }>) => void
  ): () => void {
    const wrapped = (event: RuntimeEvent) => handler(event as Extract<RuntimeEvent, { type: T }>);
    this.emitter.on(type, wrapped);
    return () => this.emitter.off(type, wrapped);
  }
}
