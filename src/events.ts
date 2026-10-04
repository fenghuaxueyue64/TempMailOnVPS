// src/events.ts — 进程内事件总线：新邮件 → WS/SSE 推送
import { EventEmitter } from "node:events";

export interface MailEvent {
  emailId: string;
  mailboxId: string;
  address: string;
  from: string;
  subject: string;
  receivedAt: string;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(0); // 每个订阅连接一个 listener，不设上限

export const bus = {
  emitMail(e: MailEvent) {
    emitter.emit("mail", e);
  },
  onMail(fn: (e: MailEvent) => void) {
    emitter.on("mail", fn);
    return () => emitter.off("mail", fn);
  },
};
