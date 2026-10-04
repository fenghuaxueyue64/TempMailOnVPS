// src/smtp/server.ts — SMTP 入站服务器（smtp-server 包）
import { SMTPServer, type SMTPServerSession, type SMTPServerDataStream } from "smtp-server";
import type { MailStore } from "../mail/store";

export interface SmtpOptions {
  port: number;
  hostname: string;
  maxClients: number;
  maxMessageBytes: number;
  store: MailStore;
}

/**
 * smtp-server 的 session 不自带 recipients 列表（onRcptTo 由调用方自行累积），
 * 用此符号键挂在 session 上，避免与库字段冲突。
 */
interface SessionState {
  recipients: string[];
}
const state = new WeakMap<SMTPServerSession, SessionState>();

export function createSmtpServer(opts: SmtpOptions): SMTPServer {
  const server = new SMTPServer({
    banner: `${opts.hostname} ESMTP TempMail Ready`,
    name: opts.hostname,
    maxClients: opts.maxClients,
    size: opts.maxMessageBytes, // SIZE 扩展：最大消息字节数
    authOptional: true, // 入站收信无需认证
    hideSTARTTLS: true,

    onMailFrom(_address, session, callback) {
      state.set(session, { recipients: [] }); // 新事务重置收件人
      callback();
    },

    onRcptTo(address, session, callback) {
      const addr = (address.address ?? "").trim().toLowerCase();
      const domain = addr.split("@")[1] ?? "";
      if (!opts.store.isOurDomain(domain)) {
        callback(new Error("550 5.1.1 relaying denied"));
        return;
      }
      state.get(session)?.recipients.push(addr);
      callback();
    },

    onData(stream: SMTPServerDataStream, session: SMTPServerSession, callback) {
      const recipients = state.get(session)?.recipients ?? [];
      const chunks: Buffer[] = [];
      let total = 0;
      let tooBig = false;
      stream.on("data", (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > opts.maxMessageBytes) {
          tooBig = true;
          stream.destroy(); // 超限直接断流，返回 552
          return;
        }
        chunks.push(chunk);
      });
      stream.on("error", (err: Error) => callback(err));
      stream.on("end", async () => {
        if (tooBig) {
          callback(new Error("552 message exceeds fixed maximum message size"));
          return;
        }
        const raw = Buffer.concat(chunks);
        try {
          let storedAny = false;
          for (const rcpt of recipients) {
            const id = await opts.store.store(raw, rcpt);
            if (id) storedAny = true;
          }
          callback(null, "message stored");
          if (storedAny) {
            console.log(`smtp: stored message for ${recipients.join(", ")} (${raw.byteLength} bytes)`);
          }
        } catch (err) {
          console.error("smtp: store error", err);
          callback(new Error("451 temporary failure, try again later"));
        }
      });
    },
  });

  // 防错误冒泡导致进程退出
  server.on("error", (err) => console.error("smtp server error:", err.message));
  return server;
}

export function startSmtp(server: SMTPServer, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}
