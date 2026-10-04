// src/mail/store.ts — 邮件解析入库（SMTP DATA / 未来 webhook 共用）
import { simpleParser, type ParsedMail, type AddressObject } from "mailparser";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { q, type DB } from "../db/client";
import { bus } from "../events";

export interface StoreOptions {
  db: DB;
  domains: string[];
  attDir: string;
  attMaxSize: number;
}

export class MailStore {
  constructor(private opts: StoreOptions) {
    mkdirSync(opts.attDir, { recursive: true });
  }

  /** 是否本服务管理的域（精确匹配，小写） */
  isOurDomain(domain: string): boolean {
    return this.opts.domains.includes(domain.toLowerCase());
  }

  /**
   * 解析并存储一封原始邮件。仅当收件地址对应一个**已存在且未过期**的邮箱时入库，
   * 否则静默丢弃（临时邮箱先创建后收信，防向任意地址刷库）。
   * 返回入库的 email id；未入库返回 null。
   */
  async store(raw: Buffer, rcptTo: string): Promise<string | null> {
    const to = rcptTo.trim().toLowerCase();
    const mb = q.get<MailboxRow>(
      this.opts.db,
      "SELECT id, address, token, expires_at FROM mailboxes WHERE address = ? AND expires_at > datetime('now')",
      to,
    );
    if (!mb) return null;

    const parsed = await simpleParser(raw);
    const emailId = Bun.randomUUIDv7();
    const from = extractAddress(parsed.from) ?? "unknown@unknown";
    const fromName = extractName(parsed.from);
    const subject = parsed.subject ?? "";
    const bodyText = parsed.text ?? null;
    const bodyHtml = typeof parsed.html === "string" ? parsed.html : null;
    const rawSize = raw.byteLength;

    q.run(
      this.opts.db,
      `INSERT INTO emails (id, mailbox_id, message_id, from_address, from_name, to_address, subject, body_text, body_html, raw_size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      emailId,
      mb.id,
      parsed.messageId ?? null,
      from,
      fromName,
      to,
      subject,
      bodyText,
      bodyHtml,
      rawSize,
    );

    // 附件落盘（按年月分目录），超过 ATT_MAX_SIZE 的跳过
    if (parsed.attachments?.length) {
      const ym = new Date().toISOString().slice(0, 7); // "2026-10"
      const dir = join(this.opts.attDir, ym);
      mkdirSync(dir, { recursive: true });
      for (const att of parsed.attachments) {
        if (att.size > this.opts.attMaxSize) continue;
        const attId = Bun.randomUUIDv7();
        // 落盘名只保留 URL/路径安全字符（中文、空格等一律转 _），长度截断；
        // 数据库 filename 列仍存原始名（下载时用于展示），二者互不影响。
        // ★ 必须与 routes.ts 附件路径守卫的正则字符集保持一致。
        const safeName = ((att.filename ?? "attachment")
          .replace(/[^A-Za-z0-9._-]/g, "_")
          .slice(0, 80)) || "attachment";
        const relPath = `${ym}/${attId}-${safeName}`;
        writeFileSync(join(this.opts.attDir, relPath), att.content);
        q.run(
          this.opts.db,
          `INSERT INTO attachments (id, email_id, filename, content_type, size, file_path) VALUES (?, ?, ?, ?, ?, ?)`,
          attId,
          emailId,
          att.filename ?? null,
          att.contentType ?? "application/octet-stream",
          att.size,
          relPath,
        );
      }
    }

    const receivedAt = new Date().toISOString();
    bus.emitMail({
      emailId,
      mailboxId: mb.id,
      address: mb.address,
      from,
      subject,
      receivedAt,
    });
    return emailId;
  }
}

interface MailboxRow {
  id: string;
  address: string;
  token: string;
  expires_at: string;
}

function extractAddress(ao: AddressObject | AddressObject[] | undefined): string | null {
  const first = Array.isArray(ao) ? ao[0] : ao;
  return first?.value?.[0]?.address ?? null;
}

function extractName(ao: AddressObject | AddressObject[] | undefined): string | null {
  const first = Array.isArray(ao) ? ao[0] : ao;
  return first?.value?.[0]?.name ?? null;
}
